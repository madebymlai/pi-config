import { SelectList, truncateToWidth, stripTerminalSequences, visibleWidth, matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
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
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
// Terminal attributes respect both light and dark palettes without fixed colors.
const theme = {
  selectedPrefix: plain,
  selectedText: (text: string) => `\x1b[7m${text}\x1b[27m`,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};
// External display strings must not inject terminal controls or additional rows.
// eslint-disable-next-line no-control-regex
const singleLine = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");

function pad(text: string, width: number, right = false): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  const space = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return right ? space + clipped : clipped + space;
}

/** One width policy for headings and rows. Drop secondary columns before names. */
function columns(agent: string, activity: string, elapsed: string, width: number, showStatus: boolean): string {
  if (width < 32) return pad(agent, width);
  const timeWidth = 7;
  const activityWidth = showStatus && width >= 54 ? Math.floor(width * 0.35) : 0;
  const agentWidth = width - timeWidth - 3 - (activityWidth ? activityWidth + 3 : 0);
  return pad(agent, agentWidth) + "   " +
    (activityWidth ? pad(activity, activityWidth) + "   " : "") +
    pad(elapsed, timeWidth, true);
}

function activityText(snapshot: StatusSnapshot): string {
  if (snapshot.kind !== "active") return singleLine(snapshot.statusLabel || snapshot.kind);
  const activity = snapshot.activityLabel || snapshot.activeScope || "working";
  return singleLine(`${activity}${snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : ""}`);
}

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
      for (const key of ["activityLabel", "statusLabel", "activeScope", "activeDurationText"]) {
        if (row.snapshot[key] != null && typeof row.snapshot[key] !== "string") return undefined;
      }
      surfaces.add(row.surface);
    }
    return value;
  } catch { return undefined; }
}

export class SurfaceList implements Component {
  private data: SurfaceListSnapshot = { rows: [], showStatus: true };
  private list = new SelectList([], 8, theme);
  private maxVisible = 8;
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
    const rows = new Map(this.data.rows.map((row) => [row.surface, row]));
    this.list = new SelectList(this.data.rows.map((row) => ({
      value: row.surface,
      label: singleLine(row.name),
    })), this.maxVisible, theme, {
      truncatePrimary: ({ item, maxWidth }) => {
        const row = rows.get(item.value)!;
        return columns(
          singleLine(`${row.name}${row.agent ? ` (${row.agent})` : ""}`),
          activityText(row.snapshot),
          formatElapsedDuration(row.elapsedMs),
          maxWidth,
          this.data.showStatus,
        );
      },
    });
    this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => { this.invoke(() => this.options.onSelect(item.value)); };
  }

  setHeight(height: number): void {
    this.height = Math.max(1, height);
    const maxVisible = Math.max(1, this.height - this.headerHeight() - this.footerHeight() - 1);
    if (maxVisible === this.maxVisible) return;
    const index = this.selectedIndex();
    this.maxVisible = maxVisible;
    this.rebuild(index);
  }

  private headerHeight(): number {
    return this.height >= 10 ? 3 : this.height >= 3 ? 1 : 0;
  }

  private footerHeight(): number {
    return this.height >= 10 ? 2 : this.height >= 4 ? 1 : 0;
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
    const count = `${this.data.rows.length} running`;
    const title = bold("Subagents") + (width >= 24
      ? " ".repeat(Math.max(1, width - 9 - count.length)) + dim(count)
      : "");
    const header = [title, "", dim("  " + columns("AGENT", "ACTIVITY", "ELAPSED", Math.max(0, width - 4), this.data.showStatus))]
      .slice(0, this.headerHeight());
    const actions = this.error ? `Error: ${this.error}`
      : width >= 64
        ? `${bold("↑↓")} Select   ${bold("PgUp/PgDn")} Page   ${bold("Enter/click")} Open   ${bold("Esc")} Main`
        : `${bold("Enter")} Open   ${bold("Esc")} Main`;
    const footer = this.footerHeight() === 2
      ? [dim("─".repeat(Math.max(0, width))), actions]
      : this.footerHeight() === 1
        ? [this.error ? `Error: ${this.error}` : "Enter  Open    Esc  Main"]
        : [];
    const bodyHeight = this.height - header.length - footer.length;
    const body = this.data.rows.length ? this.list.render(Math.max(4, width)) : [dim("  No running agents")];
    const lines = [...header, ...body.slice(0, bodyHeight)];
    while (lines.length < this.height - footer.length) lines.push("");
    return [...lines, ...footer].map((line) => truncateToWidth(line, Math.max(0, width), ""));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
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
    const row = event.y - this.headerHeight();
    if (row < 0 || row >= Math.min(this.maxVisible, this.data.rows.length) || event.x < 0 || event.x >= event.width) return undefined;
    return this.list.handleMouse({ ...event, y: row });
  }
  invalidate(): void { this.list.invalidate(); }
}
