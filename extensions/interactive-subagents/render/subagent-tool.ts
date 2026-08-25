/**
 * How the subagent tool call itself appears in the transcript.
 *
 * renderCall runs while the model is still generating the tool arguments, so it
 * is called repeatedly against a growing, half-formed object. Every field here is
 * therefore treated as possibly absent and possibly the wrong type: this is the
 * one renderer whose input is genuinely partial by design, not by accident.
 */
import { Text } from "@earendil-works/pi-tui";
import type { RenderTheme } from "./theme.ts";

/** First line of the task, bounded, for the one-line preview. */
const TASK_PREVIEW_LIMIT = 100;

/** A string argument, or "" when the model has not written it yet. */
function stringArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * The header line: which subagent, optionally its role and working directory.
 *
 * The role is only shown separately when a distinct cosmetic name was given,
 * since "Scout (scout)" says nothing the name did not.
 */
function callHeader(args: Record<string, unknown>, theme: RenderTheme): string {
  const agentName = stringArg(args, "agent");
  const name = stringArg(args, "name") || agentName || "(unnamed)";
  const agent = agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
  const cwd = stringArg(args, "cwd");
  const cwdHint = cwd ? theme.fg("dim", ` in ${cwd}`) : "";
  return "○ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;
}

export function renderSubagentCall(args: Record<string, unknown>, theme: RenderTheme) {
  let text = callHeader(args, theme);

  // Compact on purpose: this is redrawn on every token of the task as the model
  // writes it, and the full content is one keypress away on the result.
  const task = stringArg(args, "task");
  if (task) {
    const firstLine = task.split("\n").find((line) => line.trim()) ?? "";
    const preview =
      firstLine.length > TASK_PREVIEW_LIMIT
        ? firstLine.slice(0, TASK_PREVIEW_LIMIT) + "…"
        : firstLine;
    if (preview) text += "\n" + theme.fg("toolOutput", preview);

    const totalLines = task.split("\n").length;
    if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
  }

  return new Text(text, 0, 0);
}

export function renderSubagentToolResult(
  details: Record<string, unknown> | null | undefined,
  fallbackText: string,
  theme: RenderTheme,
) {
  const name = typeof details?.name === "string" ? details.name : "(unnamed)";

  // The tool returns as soon as the pane exists; the run's actual outcome
  // arrives later as a subagent_result message.
  if (details?.status === "started") {
    return new Text(
      theme.fg("accent", "⟳") + " " + theme.fg("toolTitle", theme.bold(name)) +
        theme.fg("dim", " — started"),
      0,
      0,
    );
  }

  return new Text(theme.fg("dim", fallbackText), 0, 0);
}
