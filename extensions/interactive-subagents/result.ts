/**
 * How a finished subagent is described: the message handed back to the
 * orchestrator, and the usage line shown beneath it.
 *
 * The usage line is why this is a module rather than a handful of formatters.
 * Rendering it used to take three calls plus arithmetic at the call site: get
 * the segments, look up the model's context window, format the gauge, then
 * re-derive the percentage the gauge had already computed internally, purely to
 * pick a colour against hardcoded thresholds. Every one of those steps except
 * the last is this module's business. Segments carry a severity now, and the
 * caller maps severity to a theme colour — which is the only part that is
 * genuinely the caller's, since the theme is.
 */
import type { SessionStats } from "./transcript.ts";

/** How alarming a usage segment is. The caller picks the colour. */
export type UsageSeverity = "normal" | "warning" | "critical";

export interface UsageSegment {
  text: string;
  severity: UsageSeverity;
}

/** Context occupancy above which the gauge stops being reassuring. */
const WARNING_ABOVE_PCT = 70;
const CRITICAL_ABOVE_PCT = 90;

export function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * The dim usage line for a completed subagent: "↑in ↓out R… W… $cost · ctx".
 *
 * The context gauge, when present, is always the last segment and is the only
 * one that can carry a severity above normal — a window we cannot identify
 * yields no percentage, so it stays normal rather than guessing.
 */
export function usageSegments(stats: SessionStats) {
  const segs: UsageSegment[] = [];
  const plain = (text: string) => segs.push({ text, severity: "normal" as const });

  if (stats.inputTokens) plain(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) plain(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) plain(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) plain(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) plain(`$${stats.cost.toFixed(3)}`);

  if (stats.contextTokens > 0) {
    const window = contextWindowFor(stats.model);
    const pct = window ? (stats.contextTokens / window) * 100 : 0;
    segs.push({
      text: formatContextUsage(stats.contextTokens, window),
      severity:
        pct > CRITICAL_ABOVE_PCT ? "critical" : pct > WARNING_ABOVE_PCT ? "warning" : "normal",
    });
  }

  return segs;
}

/** How a run ended. Both summary functions rank these two fields the same way. */
export interface RunOutcome {
  exitCode: number;
  /** Provider/agent error when auto-retry was exhausted (overload, rate limit…). */
  errorMessage?: string;
}

/** What `describeResult` needs to know about a finished run. */
export interface FinishedRun extends RunOutcome {
  elapsed: number;
  summary: string;
}

/**
 * What a run is said to have produced when it left no assistant message to
 * quote — it crashed, wrote nothing, or failed before its first turn.
 *
 * A provider error outranks the exit code here for the same reason it does in
 * `describeResult`: "exited with code 1" hides why.
 */
export function fallbackSummary(outcome: RunOutcome) {
  if (outcome.errorMessage) return `Subagent error: ${outcome.errorMessage}`;
  if (outcome.exitCode !== 0) return `Sub-agent exited with code ${outcome.exitCode}`;
  return "Sub-agent exited without output";
}

/**
 * The message handed back to the orchestrator when a subagent finishes.
 *
 * A provider error outranks the exit code: the run produced no usable result,
 * so saying "failed (exit 1)" would hide why. Every variant ends with the same
 * follow-up handle, because the name steers a running subagent and resumes a
 * finished one alike.
 */
export function describeResult(result: FinishedRun, name: string) {
  const sessionRef = `\n\nFollow up with send_message({ to: "${name}", message: "…" })`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. Surface the underlying
    // provider/network failure so the orchestrator can decide whether to retry,
    // resume, or change approach instead of treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with send_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Strip what `describeResult` added, leaving just the subagent's own summary.
 *
 * This lives beside `describeResult` on purpose: it un-writes that function's
 * output, matching each preamble it can produce. Split across two files the
 * pair drifts silently — a reworded preamble simply stops being stripped, and
 * the notification shows it twice.
 */
export function stripResultPreamble(
  content: string,
  opts: { name: string; elapsedText: string; exitCode: number },
) {
  const { name, elapsedText, exitCode } = opts;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return content
    .replace(/\n\nFollow up with send_message[\s\S]+$/, "")
    .replace(`Sub-agent "${name}" completed (${elapsedText}).\n\n`, "")
    .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
    .replace(
      new RegExp(
        `^Sub-agent "${escaped}" failed after ${elapsedText} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
      ),
      "",
    );
}
