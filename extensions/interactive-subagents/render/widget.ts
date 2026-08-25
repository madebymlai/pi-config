/**
 * How a set of running subagents looks in the terminal widget, and nothing
 * about what they are doing.
 *
 * The whole module is one function of its arguments. That is deliberate: the
 * renderer used to call `Date.now()` itself and read a module-level status
 * config, which meant a test asserting "no line exceeds the terminal width" had
 * to patch the clock and build three complete subagent records — id, task,
 * surface and session file included — none of which the renderer reads.
 * Elapsed time and the status toggle are parameters now, so a row is the four
 * things that actually reach the screen.
 *
 * It knows nothing about a running subagent beyond `StatusSnapshot`: the caller
 * maps its own records to rows, which keeps the launcher's shape out of here.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusSnapshot } from "../observe/status-snapshot.ts";

export interface WidgetRow {
  /** Display name, unique per spawner session. */
  name: string;
  /** Agent role, shown parenthesised. Absent on resumed runs. */
  agent?: string;
  /** Time since launch. Passed in so rendering stays a pure function. */
  elapsedMs: number;
  snapshot: StatusSnapshot;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * MM:SS. Negative elapsed is clamped to zero: a backwards clock would otherwise
 * render "-1:-1" in the widget. This is the one deliberate difference from the
 * pre-extraction renderer, which had no clamp.
 */
function formatMMSS(elapsedMs: number) {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function rightLabel(snapshot: StatusSnapshot) {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

/**
 * Render the whole widget: a titled box with one line per running subagent.
 *
 * Every returned line has a visible width of exactly `width`, or less when
 * `width` is too small to draw a box at all. `showStatus` off pins each row's
 * right-hand label to "starting…", which is what the status-disabled config
 * renders rather than a live label.
 */
export function renderSubagentWidget(
  rows: readonly WidgetRow[],
  width: number,
  opts: { showStatus: boolean },
) {
  const lines: string[] = [borderTop("Subagents", `${rows.length} running`, width)];

  for (const row of rows) {
    const agentTag = row.agent ? ` (${row.agent})` : "";
    const icon = widgetIcon(row.snapshot.kind);
    const left = ` ${icon} ${formatMMSS(row.elapsedMs)}  ${row.name}${agentTag} `;
    const right = opts.showStatus ? rightLabel(row.snapshot) : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}
