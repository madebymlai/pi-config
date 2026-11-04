import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSurfaces } from "../spawn/tmux.ts";
import { registerName } from "../store/name-registry.ts";
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

// These unit lifecycle tests must never operate on the invoking user's deck.
const savedTmux = process.env.TMUX;
before(() => { delete process.env.TMUX; });
after(() => {
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

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
  it("labels fresh and resumed panes with the display name and actual role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-header-wiring-"));
    const socket = join(dir, "socket");
    const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
    const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
    const children = createChildren();
    try {
      const main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "headers", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
      // New panes never read the typed launch commands: no real agent is started.
      tmux("set-option", "-g", "default-command", "sleep 600");
      process.env.TMUX = `${socket},0,0`;
      process.env.TMUX_PANE = main;
      process.env.PI_CODING_AGENT_DIR = dir;
      const { api, registeredTools } = createMockExtensionApi();
      const { ctx } = createMockContext({ sessionDir: dir, sessionId: "parent" });
      ctx.cwd = dir;
      ctx.sessionManager.getSessionFile = () => join(dir, "parent.jsonl");
      subagentsModule.default(api, { children });
      const spawn = registeredTools.find(t => t.name === "subagent")!;
      const out = await spawn.execute("spawn", { agent: "scout", name: "Ada", task: "inspect" }, undefined, undefined, ctx);
      assert.equal(children.live().length, 1, JSON.stringify(out));
      const fresh = children.live()[0];
      assert.equal(tmux("show-options", "-pqv", "-t", fresh.surface, "@pi-label"), "Ada (scout)");
      const session = join(dir, "finished.jsonl");
      writeFileSync(session, "");
      writeFileSync(`${session}.loadout.json`, JSON.stringify({ agent: "reviewer", toolAllowlist: null, model: null, thinking: null, systemPromptMode: null, identity: null, autoExit: true, cwd: dir, agentDir: dir }));
      registerName(join(dir, "artifacts", "parent"), "Grace", { sessionFile: session, sessionId: "finished" });
      const send = registeredTools.find(t => t.name === "send_message")!;
      const resumed = await send.execute("resume", { to: "Grace", message: "continue" }, undefined, undefined, ctx);
      assert.equal(resumed.details.status, "resumed");
      const running = children.live().find(c => c.name === "Grace")!;
      assert.equal(tmux("show-options", "-pqv", "-t", running.surface, "@pi-label"), "Grace (reviewer)");
    } finally {
      children.shutdown();
      disposeSurfaces();
      tmux("kill-server");
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps the main widget to the running count without shortcut hints", async () => {
    const { api, emit } = createMockExtensionApi();
    const ui = createMockContext();
    const children = createChildren();
    subagentsModule.default(api, { children });
    await emit("session_start", {}, ui.ctx);
    try {
      await children.launch({ base: "scout", start: async (n) => entry("1", n), watch: forever });
      await children.launch({ base: "worker", start: async (n) => entry("2", n), watch: forever });
      const factory = ui.currentWidget() as Function;
      const lines = factory({}, ui.ctx.ui.theme).render(80);
      assert.equal(lines.length, 1, "the full agent list belongs in the right pane, not above the main input");
      assert.deepEqual(lines, ["2 subagents"]);
    } finally {
      children.shutdown();
    }
  });

  it("replaces the browse command with a named shortcut in the main session", async () => {
    const { api, registeredCommands, registeredShortcuts } = createMockExtensionApi();
    const ui = createMockContext();
    subagentsModule.default(api, { children: createChildren() });
    assert.ok(!registeredCommands.some((c) => c.name === "subagent-view"), "the retired command must be removed completely");
    const shortcut = registeredShortcuts.find((s) => s.key === "ctrl+alt+a");
    assert.ok(shortcut, "the main pane needs the same agent-list shortcut as children");
    await shortcut.handler(ui.ctx);
    assert.match(ui.notifications.at(-1)?.text ?? "", /no.*subagents/i);
  });

  it("enables empty-prompt left navigation in main only while agents are live", async () => {
    const { api, emit } = createMockExtensionApi();
    const { ctx, terminalInputListeners } = createMockContext();
    ctx.mode = "tui";
    let forwarded = 0;
    ctx.ui.setEditorComponent(() => ({ getText: () => "", handleInput() { forwarded++; } }));
    const children = createChildren();
    subagentsModule.default(api, { children });
    await emit("session_start", {}, ctx);
    try {
      const editor = ctx.ui.getEditorComponent()({}, {}, {});
      editor.handleInput("\x1b[D");
      assert.equal(forwarded, 1, "without agents, leave the editor alone");
      await children.launch({ base: "a", start: async (n) => entry("1", n), watch: forever });
      editor.handleInput("\x1b[D");
      assert.equal(forwarded, 1, "with agents, empty-prompt left opens the list");
      assert.deepEqual([...terminalInputListeners][0]("\x1b\x01"), { consume: true });
    } finally {
      await emit("session_shutdown", {}, ctx);
    }
  });

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
