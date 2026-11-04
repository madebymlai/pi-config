import { SelectList, truncateToWidth, stripTerminalSequences, matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { formatElapsedDuration, type StatusSnapshot } from "../observe/status-snapshot.ts";

export interface SurfaceListRow {
  surface: string;
  name: string;
  agent?: string;
  elapsedMs: number;
  snapshot: StatusSnapshot;
}
export interface SurfaceListSnapshot {
  rows: SurfaceListRow[];
  showStatus: boolean;
}
interface Options {
  onSelect(surface: string): void | Promise<void>;
  onBack(): void | Promise<void>;
  requestRender?(): void;
}
const plain = (text: string) => text;
const theme = { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain };
// External display strings must not inject terminal controls or additional rows.
// eslint-disable-next-line no-control-regex
const singleLine = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");

/** Parse the external snapshot without replacing the last good view on partial writes. */
export function parseSurfaceListSnapshot(text: string): SurfaceListSnapshot | undefined {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.showStatus !== "boolean" || !Array.isArray(value.rows)) return undefined;
    const surfaces = new Set<string>();
    for (const row of value.rows) {
      if (!row || typeof row.surface !== "string" || !row.surface || surfaces.has(row.surface)
        || typeof row.name !== "string" || (row.agent !== undefined && typeof row.agent !== "string")
        || typeof row.elapsedMs !== "number" || !Number.isFinite(row.elapsedMs)
        || !row.snapshot || !["starting", "active", "waiting", "stalled"].includes(row.snapshot.kind)) return undefined;
      for (const key of ["activityLabel", "statusLabel"]) {
        if (row.snapshot[key] != null && typeof row.snapshot[key] !== "string") return undefined;
      }
      surfaces.add(row.surface);
    }
    return value;
  } catch { return undefined; }
}

export class SurfaceList implements Component {
  private data: SurfaceListSnapshot = { rows: [], showStatus: true };
  private list = new SelectList([], 10, theme);
  private maxVisible = 10;
  private height = 14;
  private error = "";
  private options: Options;

  constructor(options: Options) { this.options = options; }

  update(data: SurfaceListSnapshot): void {
    const selected = this.list.getSelectedItem()?.value;
    const oldIndex = this.data.rows.findIndex((row) => row.surface === selected);
    this.data = data;
    const index = data.rows.findIndex((row) => row.surface === selected);
    this.rebuild(index < 0 ? Math.max(0, oldIndex) : index);
    this.options.requestRender?.();
  }

  private rebuild(index: number): void {
    this.list = new SelectList(this.data.rows.map((row) => ({
      value: row.surface,
      label: singleLine(`${row.name}${row.agent ? ` (${row.agent})` : ""} · ${formatElapsedDuration(row.elapsedMs)}${this.data.showStatus ? ` · ${row.snapshot.statusLabel === "done" ? "done" : row.snapshot.kind}${row.snapshot.activityLabel ? ` · ${row.snapshot.activityLabel}` : ""}` : ""}`),
    })), this.maxVisible, theme);
    this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => { this.invoke(() => this.options.onSelect(item.value)); };
  }

  setHeight(height: number): void {
    this.height = Math.max(1, height);
    const maxVisible = Math.max(1, height - 4);
    if (maxVisible === this.maxVisible) return;
    const index = this.selectedIndex();
    this.maxVisible = maxVisible;
    this.rebuild(index);
  }

  private selectedIndex(): number {
    return Math.max(0, this.data.rows.findIndex((row) => row.surface === this.list.getSelectedItem()?.value));
  }

  private invoke(callback: () => void | Promise<void>): void {
    this.error = "";
    const failed = (error: unknown) => {
      this.error = singleLine(error instanceof Error ? error.message : String(error));
      this.options.requestRender?.();
    };
    try {
      const result = callback();
      if (result) void result.catch(failed);
    } catch (error) { failed(error); }
  }

  render(width: number): string[] {
    return ["Agents", ...(this.data.rows.length ? this.list.render(Math.max(4, width)) : ["No live agents"]),
      this.error ? `Error: ${this.error}` : "Enter/click open · Ctrl+Z returns from agent",
      "↑↓ move · PgUp/PgDn · Esc/Ctrl+Z main",
    ].slice(0, this.height).map((line) => truncateToWidth(line, Math.max(0, width), ""));
  }

  handleInput(data: string): void {
    if ((["ctrl+z", "ctrl+c", "escape"] as const).some((key) => matchesKey(data, key))) {
      this.invoke(this.options.onBack);
    } else if (matchesKey(data, "pageUp")) {
      this.list.setSelectedIndex(this.selectedIndex() - this.maxVisible);
    } else if (matchesKey(data, "pageDown")) {
      this.list.setSelectedIndex(this.selectedIndex() + this.maxVisible);
    } else if (matchesKey(data, "home")) {
      this.list.setSelectedIndex(0);
    } else if (matchesKey(data, "end")) {
      this.list.setSelectedIndex(this.data.rows.length - 1);
    } else {
      this.list.handleInput(data);
    }
    this.options.requestRender?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < 1 || event.y > Math.min(this.maxVisible, this.data.rows.length) || event.x < 0 || event.x >= event.width) return undefined;
    return this.list.handleMouse({ ...event, y: event.y - 1 });
  }
  invalidate(): void { this.list.invalidate(); }
}
