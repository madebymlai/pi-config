/**
 * The box a finished subagent leaves behind.
 *
 * It has to answer three things at a glance: did it work, what did it cost, and
 * what did it say. Failure is surfaced with a reason rather than an icon alone,
 * because "exit 1" and "the provider errored" want different responses from the
 * reader.
 *
 * The summary arrives with a preamble the orchestrator needs and a reader does
 * not, so it is stripped for display only; the message content itself is left
 * alone because that is what the model reads.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { formatElapsed, stripResultPreamble, usageSegments, type UsageSeverity } from "./result.ts";
import type { SessionStats } from "../observe/transcript.ts";
import { asRecord, type RenderContext, type RenderTheme } from "./theme.ts";

/** How much of the context budget is gone, as a colour. */
const USAGE_TONE = {
  normal: "dim",
  warning: "warning",
  critical: "error",
} as const satisfies Record<UsageSeverity, string>;

/** How many summary lines a collapsed box shows before it stops. */
const COLLAPSED_SUMMARY_LINES = 5;

export interface SubagentResultDetails {
  /**
   * Absent when the payload carried no name. Kept optional rather than defaulted
   * here because the expanded box gates its follow-up section on whether a name
   * was actually given: defaulting at read time would make that gate always true
   * and print a hint addressed to a subagent nobody can reach.
   */
  name?: string;
  /** The role it was spawned as, when it was spawned as one. */
  agent?: string;
  /** Non-zero means the process failed, whatever it managed to say first. */
  exitCode: number;
  /** A provider or agent error, which counts as failure even on a clean exit. */
  errorMessage: string;
  /** Whole seconds, as formatElapsed takes, or null when the run was never timed. */
  elapsed: number | null;
  /** Absent when the session file could not be summarised. */
  stats: SessionStats | null;
  sessionFile?: string;
}

/** Reads a message's untyped details, or null when this is not our message. */
export function readSubagentResultDetails(details: unknown): SubagentResultDetails | null {
  const record = asRecord(details);
  if (!record) return null;
  return {
    // Kept verbatim, empty string included: the original used ?? for display,
    // which preserves "", and truthiness for the follow-up gate, which rejects it.
    name: typeof record.name === "string" ? record.name : undefined,
    agent: typeof record.agent === "string" && record.agent ? record.agent : undefined,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : 0,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : "",
    elapsed: typeof record.elapsed === "number" ? record.elapsed : null,
    stats: (record.stats ?? null) as SessionStats | null,
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
  };
}

function renderHeader(
  details: SubagentResultDetails,
  theme: RenderTheme,
  failed: boolean,
  elapsed: string,
) {
  const displayName = details.name ?? "subagent";
  const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
  const modelTag = details.stats?.model ? theme.fg("dim", ` (${details.stats.model})`) : "";
  const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(displayName))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

  if (failed) {
    // "exit 1" and "the provider errored" call for different responses, so say which.
    const reason = details.errorMessage
      ? "failed (provider/agent error)"
      : `failed (exit ${details.exitCode})`;
    return `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
  }

  // The icon already says "completed", so spend the line on what it cost.
  const toolPart = details.stats ? `${details.stats.toolCount} tools · ${elapsed}` : elapsed;
  return `${titleSegment}${theme.fg("dim", toolPart)}`;
}

export function renderSubagentResult(
  details: SubagentResultDetails,
  content: string,
  { theme, expandHint, expanded, width }: RenderContext,
) {
  const failed = details.exitCode !== 0 || !!details.errorMessage;
  const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";

  const contentLines = [renderHeader(details, theme, failed, elapsed)];

  if (details.stats) {
    const segments = usageSegments(details.stats).map((s) => theme.fg(USAGE_TONE[s.severity], s.text));
    if (segments.length > 0) contentLines.push(segments.join(theme.fg("dim", " ")));
  }

  const summary = stripResultPreamble(content, {
    name: details.name ?? "subagent",
    elapsedText: elapsed,
    exitCode: details.exitCode,
  });

  if (expanded) {
    if (summary) {
      for (const line of summary.split("\n")) contentLines.push(line.slice(0, width - 6));
    }
    if (details.name || details.sessionFile) {
      contentLines.push("");
      if (details.name) {
        contentLines.push(
          theme.fg("dim", `Follow up:  send_message({ to: "${details.name}", message: "…" })`),
        );
      }
      if (details.sessionFile) {
        contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
      }
    }
  } else {
    if (summary) {
      const lines = summary.split("\n");
      for (const line of lines.slice(0, COLLAPSED_SUMMARY_LINES)) {
        contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
      }
      if (lines.length > COLLAPSED_SUMMARY_LINES) {
        contentLines.push(theme.fg("muted", `… ${lines.length - COLLAPSED_SUMMARY_LINES} more lines`));
      }
    }
    contentLines.push(theme.fg("muted", expandHint()));
  }

  const bgFn = failed
    ? (text: string) => theme.bg("toolErrorBg", text)
    : (text: string) => theme.bg("toolSuccessBg", text);
  const box = new Box(1, 1, bgFn);
  box.addChild(new Text(contentLines.join("\n"), 0, 0));
  return ["", ...box.render(width)];
}
