/**
 * The periodic "here is what your subagents are doing" box.
 *
 * It renders lines the caller has already capped, plus the count of what was
 * left out. Both come from one renderStatusDigest call, so the box and the
 * message body beside it cannot disagree about which subagents are shown.
 */
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { RenderContext } from "./theme.ts";

export interface SubagentStatusDetails {
  /** Already capped to the configured limit by renderStatusDigest. */
  lines: string[];
  /** How many running subagents are not in `lines`. */
  overflow: number;
}

/** Reads a message's untyped details, or null when this is not our message. */
export function readSubagentStatusDetails(details: unknown): SubagentStatusDetails | null {
  if (details == null || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  const lines = Array.isArray(record.lines) ? (record.lines as string[]) : [];
  const overflow = typeof record.overflow === "number" ? record.overflow : 0;
  // Nothing to say is not the same as a message we cannot render.
  if (lines.length === 0 && overflow === 0) return null;
  return { lines, overflow };
}

export function renderSubagentStatus(
  details: SubagentStatusDetails,
  { theme, expandHint, expanded, width }: RenderContext,
): string[] {
  const lineWidth = Math.max(0, width - 6);
  const contentLines = [
    `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
    ...details.lines.map((line) => theme.fg("dim", truncateToWidth(line, lineWidth))),
  ];

  if (details.overflow > 0) {
    contentLines.push(theme.fg("muted", `+${details.overflow} more running.`));
  }
  if (!expanded) contentLines.push(theme.fg("muted", expandHint()));

  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new Text(contentLines.join("\n"), 0, 0));
  return ["", ...box.render(width)];
}
