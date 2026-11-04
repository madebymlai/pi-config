import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal, TuiAltScreen, getKeybindings } from "@earendil-works/pi-tui";
import { SurfaceList, parseSurfaceListSnapshot } from "../render/surface-list.ts";
import { showSurface, focusSurfaceParent } from "../spawn/tmux.ts";

function main(file: string): void {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  // Selection owns paging here; there is no transcript to scroll.
  const keybindings = getKeybindings();
  keybindings.setUserBindings({ ...keybindings.getUserBindings(),
    "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [],
  });
  const list = new SurfaceList({ onSelect: showSurface, onBack: focusSurfaceParent,
    requestRender: () => tui.requestRender() });
  const root = {
    render(width: number) { list.setHeight(terminal.rows); return list.render(width); },
    invalidate() { list.invalidate(); },
    handleInput(data: string) { list.handleInput(data); },
    handleMouse: list.handleMouse.bind(list),
  };
  tui.addChild(root);
  tui.setLayoutRoot(root);
  tui.setFocus(root);
  const poll = () => {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    const snapshot = parseSurfaceListSnapshot(text);
    if (snapshot) list.update(snapshot);
  };
  poll();
  tui.start();
  const timer = setInterval(poll, 500);
  const stop = () => { clearInterval(timer); tui.stop(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: surface-list.ts <snapshot.json>");
  main(process.argv[2]);
}
