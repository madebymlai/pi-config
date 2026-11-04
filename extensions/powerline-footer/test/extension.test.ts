import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

type FooterComponent = { render(width: number): string[]; dispose?(): void };
function harness(mode = "tui") {
  const handlers = new Map<string, Function>();
  let footer: FooterComponent | undefined;
  let leaf = "a",
    session = "one",
    reads = 0,
    subscriptions = 0,
    renders = 0;
  let thinking = "high";
  let used: number | null = 123000;
  const statuses = new Map<string, string>();
  const usage = (input: number, output: number) => ({ input, output });
  const entries = [
    { type: "message", message: { role: "assistant", usage: usage(100, 10) } },
    { type: "message", message: { role: "toolResult", usage: usage(200, 20) } },
    { type: "usage", usage: usage(300, 30) },
    { type: "compaction", usage: usage(400, 40) },
    { type: "branch_summary", usage: usage(500, 50) },
    { type: "message", message: { role: "user", content: "hello" } },
  ];
  const ctx = {
    mode,
    cwd: "/work/pi-config",
    model: { id: "model-one", contextWindow: 273000 },
    getContextUsage: () => ({ tokens: used }),
    sessionManager: {
      getSessionId: () => session,
      getLeafId: () => leaf,
      getEntries: () => {
        reads++;
        return entries;
      },
    },
    ui: {
      setFooter(factory: Function | undefined) {
        footer?.dispose?.();
        footer = factory?.(
          { requestRender: () => renders++ },
          { style: (s: string) => s },
          {
            getGitBranch: () => "main",
            getExtensionStatuses: () => statuses,
            onBranchChange: () => {
              subscriptions++;
              return () => subscriptions--;
            },
          },
        );
      },
    },
  };
  extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    getThinkingLevel: () => thinking,
  } as unknown as ExtensionAPI);
  return {
    ctx,
    entries,
    statuses,
    emit: (event: string) =>
      handlers.get(event)?.({}, ctx as unknown as ExtensionContext),
    render: () => footer!.render(160)[0],
    get footer() {
      return footer;
    },
    get reads() {
      return reads;
    },
    get subscriptions() {
      return subscriptions;
    },
    get renders() {
      return renders;
    },
    change: () => {
      ctx.model = { id: "model-two", contextWindow: 200000 };
      thinking = "low";
      used = null;
    },
    append: () => {
      entries.push({ type: "usage", usage: usage(600, 60) });
      leaf = "b";
    },
    switch: () => {
      session = "two";
      entries.length = 0;
    },
  };
}

test("TUI installation subscribes once, replacement and shutdown dispose the branch listener", () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness(mode);
    h.emit("session_start");
    assert.equal(h.footer, undefined);
  }
  const h = harness();
  h.emit("session_start");
  assert.equal(h.subscriptions, 1);
  h.emit("session_start");
  assert.equal(h.subscriptions, 1);
  h.emit("session_shutdown");
  assert.equal(h.subscriptions, 0);
  h.emit("session_shutdown");
  assert.equal(h.subscriptions, 0);
});

test("model and thinking changes request a repaint and live data never uses the totals cache", () => {
  const h = harness();
  h.emit("session_start");
  assert.ok(h.render().includes("model-one high"));
  assert.ok(!h.render().includes("BG ON"));
  h.change();
  h.statuses.set(" bash-guard", "⚠ BG OFF");
  h.emit("model_select");
  h.emit("thinking_level_select");
  assert.equal(h.renders, 2);
  const line = h.render();
  assert.ok(line.includes("model-two low"));
  assert.ok(line.includes("░░░░░░░░░░ ?"));
  assert.ok(line.includes("⚠ BG OFF"));
  assert.equal(h.reads, 1);
});

test("the context bar uses the effective routed capacity from the context API", () => {
  const h = harness();
  h.ctx.model = { id: "router", contextWindow: 200000 };
  h.ctx.getContextUsage = () => ({ tokens: 90000, contextWindow: 100000 });
  h.emit("session_start");
  assert.ok(h.render().includes("▰▰▰▰▰▰▰▰▰▱ 90k"), "90k of the routed 100k limit must fill nine cells, not four");
});

test("installed footer totals every usage source across all entries, caching until the leaf or session changes", () => {
  const h = harness();
  h.emit("session_start");
  assert.ok(h.render().includes("↑1.5k ↓150"));
  h.render();
  assert.equal(h.reads, 1);
  h.append();
  assert.ok(h.render().includes("↑2.1k ↓210"));
  assert.equal(h.reads, 2);
  h.switch();
  assert.ok(h.render().includes("↑0 ↓0"));
});
