import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import childExtension from "../child/index.ts";
import { createMockContext, createMockExtensionApi } from "./support/mock-extension-api.ts";

// No ambient parent/list pane may be selected by these unit tests.
const savedTmux = process.env.TMUX;
before(() => { delete process.env.TMUX; });
after(() => {
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

it("left opens agents only from an empty editor; Ctrl+Alt+A is global and Ctrl+Z stays Pi's", async () => {
  const { api, emit, registeredShortcuts } = createMockExtensionApi();
  const { ctx, terminalInputListeners } = createMockContext();
  ctx.mode = "tui";
  let text = "";
  const forwarded: string[] = [];
  const previousFactory = () => ({
    getText: () => text,
    handleInput: (data: string) => { forwarded.push(data); },
  });
  ctx.ui.setEditorComponent(previousFactory);
  childExtension(api);
  await emit("session_start", {}, ctx);

  assert.ok(registeredShortcuts.some((s) => s.key === "ctrl+alt+a" && /agent list/i.test(s.description)), "Pi's shortcut help must name the new binding");
  const factory = ctx.ui.getEditorComponent();
  assert.notEqual(factory, previousFactory, "only editor input should handle conditional left-arrow navigation");
  const editor = factory({}, {}, {});
  editor.handleInput("\x1b[D");
  assert.deepEqual(forwarded, [], "empty-editor left opens the list");
  text = "draft";
  editor.handleInput("\x1b[D");
  editor.handleInput("\x1a");
  assert.deepEqual(forwarded, ["\x1b[D", "\x1a"], "editing and Pi's suspend action must pass through");

  assert.equal(terminalInputListeners.size, 1);
  const input = [...terminalInputListeners][0];
  assert.equal(input("\x1b[D"), undefined, "raw left must not hijack dialogs even when the underlying editor is empty");
  assert.equal(input("\x1a"), undefined, "Ctrl+Z must not be intercepted");
  assert.deepEqual(input("\x1b\x01"), { consume: true }, "Ctrl+Alt+A works with a draft or focused dialog");

  await emit("session_shutdown", {}, ctx);
  assert.equal(terminalInputListeners.size, 0);
  assert.equal(ctx.ui.getEditorComponent(), previousFactory, "restore the earlier editor on shutdown");
});
