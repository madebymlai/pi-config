import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { showSurfaceList } from "../spawn/tmux.ts";

export const AGENT_LIST_HINT = "← empty prompt · Ctrl+Alt+A agents";

/** Shared navigation for the main session and children, without changing Pi's suspend key. */
export function registerSurfaceNavigation(pi: ExtensionAPI, canBrowse: () => boolean = () => true): void {
  let cleanup: (() => void) | undefined;

  const open = (ctx: ExtensionContext) => {
    if (!canBrowse()) {
      ctx.ui.notify("No running subagents to browse.", "info");
      return;
    }
    try {
      showSurfaceList();
    } catch (error) {
      ctx.ui.notify(`Cannot open subagents: ${String(error)}`, "warning");
    }
  };

  // Register as well as intercept so /hotkeys describes the real binding.
  pi.registerShortcut("ctrl+alt+a", { description: "Open agent list", handler: open });

  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    cleanup = undefined;
    if (ctx.mode !== "tui") return;

    // Only the dedicated shortcut is global: raw left-arrow interception would
    // steal navigation from dialogs whenever the underlying prompt was empty.
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+alt+a")) return;
      open(ctx);
      return { consume: true };
    });
    const previous = ctx.ui.getEditorComponent();
    const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        if (matchesKey(data, "left") && editor.getText().length === 0 && canBrowse()) {
          open(ctx);
        } else {
          handleInput(data);
        }
      };
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    cleanup = () => {
      unsubscribe();
      // Don't replace an editor installed by another extension after ours.
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    };
  });

  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
  });
}
