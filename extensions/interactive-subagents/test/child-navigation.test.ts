import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import childExtension from "../child/index.ts";
import { createMockContext, createMockExtensionApi } from "./support/mock-extension-api.ts";

// No ambient parent/list pane may be selected by this unit test.
const savedTmux = process.env.TMUX;
before(() => { delete process.env.TMUX; });
after(() => {
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

it("Ctrl+Z returns from a child without reaching Pi's suspend action, and is unbound on shutdown", async () => {
  const { api, emit } = createMockExtensionApi();
  const { ctx } = createMockContext();
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  ctx.mode = "tui";
  ctx.ui.onTerminalInput = (handler: (data: string) => { consume?: boolean } | undefined) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  };
  childExtension(api);
  await emit("session_start", {}, ctx);

  assert.equal(listeners.size, 1, "child navigation must intercept input even when a dialog owns focus");
  const input = [...listeners][0];
  assert.equal(input("a"), undefined, "ordinary input still reaches the child's editor");
  // No deck is available in this unit test. Even a failed return must not
  // fall through to SIGTSTP and suspend the child that is doing the work.
  assert.deepEqual(input("\x1a"), { consume: true });

  await emit("session_shutdown", {}, ctx);
  assert.equal(listeners.size, 0, "reload must not retain a stale navigation handler");
});
