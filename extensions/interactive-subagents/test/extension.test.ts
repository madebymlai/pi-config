import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../index.ts";
import { createChildren, type RunningSubagent } from "../spawn/children.ts";
import type { SubagentLiveness } from "../observe/liveness.ts";
import { createMockExtensionApi, createMockContext } from "./support/mock-extension-api.ts";

/**
 * The extension as pi drives it: register, then fire the session lifecycle.
 *
 * Everything here was unreachable until the mock's `on()` stopped being a
 * no-op. Two real bugs shipped behind that gap — an observer that was never
 * wired, so nothing ever painted, and a shutdown that disabled every session
 * after the first — and a fully green suite reported neither, because with no
 * session_start there is no context and every paint path returns before it can
 * be asserted on.
 */

/** Liveness is never touched by the paths under test; the widget renders lazily. */
const STUB_LIVENESS = {
  snapshot: () => ({ kind: "active", statusLabel: "active", detail: "", elapsedMs: 0 }),
  tick: () => ({ kindChanged: false, transition: null, snapshot: {} }),
  observe: () => {},
  interrupted: () => {},
} as unknown as SubagentLiveness;

function entry(id: string, name = id): RunningSubagent {
  return {
    id,
    name,
    task: "t",
    surface: `%${id}`,
    startTime: 0,
    sessionFile: `${id}.jsonl`,
    launchScriptFile: `${id}.sh`,
    liveness: STUB_LIVENESS,
  };
}

const forever = () => new Promise<void>(() => {});

describe("extension wiring", () => {
  it("paints a widget once a subagent is live", async () => {
    const { api, emit } = createMockExtensionApi();
    const ui = createMockContext();
    const children = createChildren();
    subagentsModule.default(api, { children });
    await emit("session_start", { reason: "startup" }, ui.ctx);

    await children.launch({
      base: "a",
      start: async (name) => entry("a1", name),
      watch: forever,
    });

    assert.ok(ui.currentWidget(), "a live subagent must put something above the editor");
    children.shutdown();
  });

  it("clears the widget when the last subagent finishes", async () => {
    const { api, emit } = createMockExtensionApi();
    const ui = createMockContext();
    const children = createChildren();
    subagentsModule.default(api, { children });
    await emit("session_start", { reason: "startup" }, ui.ctx);

    let finish: (() => void) | null = null;
    await children.launch({
      base: "a",
      start: async (name) => entry("a1", name),
      watch: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    assert.ok(ui.currentWidget(), "precondition: the widget is up");

    finish!();
    await new Promise((r) => setImmediate(r));

    assert.equal(ui.currentWidget(), undefined, "an empty set must leave nothing above the editor");
    children.shutdown();
  });

  it("still tracks subagents in a session that starts after another ends", async () => {
    const { api, emit } = createMockExtensionApi();
    const children = createChildren();
    subagentsModule.default(api, { children });

    const first = createMockContext();
    await emit("session_start", { reason: "startup" }, first.ctx);
    await children.launch({ base: "a", start: async (n) => entry("a1", n), watch: forever });
    await emit("session_shutdown", {}, first.ctx);

    const second = createMockContext();
    await emit("session_start", { reason: "startup" }, second.ctx);
    await children.launch({ base: "b", start: async (n) => entry("a2", n), watch: forever });

    assert.deepEqual(
      children.live().map((r) => r.id),
      ["a2"],
      "a second session's subagent must be tracked, not silently dropped",
    );
    assert.ok(second.currentWidget(), "and it must paint into the new session's context");
    children.shutdown();
  });

  it("paints into the newest context, not the one that has gone away", async () => {
    const { api, emit } = createMockExtensionApi();
    const children = createChildren();
    subagentsModule.default(api, { children });

    const stale = createMockContext();
    await emit("session_start", { reason: "startup" }, stale.ctx);
    await emit("session_shutdown", {}, stale.ctx);
    const staleWidgets = stale.widgets.length;

    const live = createMockContext();
    await emit("session_start", { reason: "startup" }, live.ctx);
    await children.launch({ base: "a", start: async (n) => entry("a1", n), watch: forever });

    assert.ok(live.currentWidget(), "the live session paints");
    assert.equal(stale.widgets.length, staleWidgets, "the finished session is not painted into");
    children.shutdown();
  });
});
