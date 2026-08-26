/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Contributes the upward transport behind `send_message`, so this session can
 *   reach the orchestrator that spawned it
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically once their run has settled (see the `agent_settled` handler);
 * interactive agents end when the human exits the pane.
 *
 * Messaging the parent keeps the session OPEN: it writes a `${sessionFile}.message`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingReply`), and the parent
 * replies with send_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity-recorder.ts";
import { PARENT, registerSendMessage } from "../protocol/messaging.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}


/**
 * Whether an auto-exit subagent should shut down, given the messages of the
 * turn that just ended.
 *
 * Asked at `agent_settled`, never at `agent_end`, and that is the whole point
 * of the name. pi decides *after* agent_end whether to auto-retry a provider
 * error, and a retry continues this same session. Deciding at agent_end turned
 * a dropped websocket — an error pi retries by default, and which succeeds on
 * the next attempt because the provider falls back to SSE — into a dead
 * subagent and a lost run. `agent_settled` fires only once no retry, no
 * compaction and no queued continuation is coming.
 */
export function shouldAutoExitOnSettled(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" also returns true — by the time a run settles pi has
  // spent its retry budget, so the session will not recover on its own — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Record how this run ended, beside its session file.
 *
 * The parent watches a tmux pane, and a pane is gone the moment nothing holds
 * it open. This file is the only account of the run that outlives the pane.
 */
export function writeExitSidecar(
  sessionFile: string | undefined,
  errorInfo: SubagentErrorInfo | null,
) {
  if (!sessionFile) return false;
  const payload = errorInfo
    ? {
        type: "error",
        errorMessage: errorInfo.errorMessage,
        stopReason: errorInfo.stopReason,
      }
    : { type: "done" };
  // Written through a temp file and renamed, like the activity file and the
  // name registry: the parent polls this path every second and parses whatever
  // it finds, and rename is the only way it sees the whole file or none of it.
  // The error payload carries a message of unbounded length, which is where a
  // torn read stops being hypothetical.
  const target = `${sessionFile}.exit`;
  const tempFile = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tempFile, JSON.stringify(payload));
    renameSync(tempFile, target);
    return true;
  } catch {
    try {
      unlinkSync(tempFile);
    } catch {
      // Cleanup is best effort; the write already failed.
    }
    // Best effort — the watcher's session-file fallback can still recover.
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when the parent is messaged; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingReply = false;
  // The turn `agent_settled` is about to rule on. It decides the exit but
  // carries no messages of its own, and pi offers extensions no way to read
  // them back, so the last `agent_end` leaves them here — with `sawAgentEnd`
  // recording that one was left at all, since a run that never reached a turn
  // is not a run to shut a session down on.
  let settledTurnMessages: any[] | undefined;
  let sawAgentEnd = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending message has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingReply = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // A new turn is starting — any pending message has now been replied to
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingReply = false;
    // This run rules on its own turn, not the one an earlier agent_end left.
    settledTurnMessages = undefined;
    sawAgentEnd = false;
    recorder.agentStart();
  });

  // The turn is over; the run may not be. pi weighs an auto-retry after this
  // event and before agent_settled, so nothing here may end the session or tell
  // the parent how the run went — a sidecar written now is read within the
  // second and the pane killed under a subagent that was about to retry.
  pi.on("agent_end", (event) => {
    settledTurnMessages = (event as any).messages as any[] | undefined;
    sawAgentEnd = true;
    recorder.agentEndWaiting();
  });

  // Nothing more is coming: no retry, no compaction, no queued continuation.
  pi.on("agent_settled", (_event, ctx) => {
    // Never shut down while a message is pending the orchestrator's reply: the
    // session parks as `waiting` and resumes when the reply lands.
    const shouldExit =
      sawAgentEnd &&
      !awaitingReply &&
      autoExit &&
      shouldAutoExitOnSettled(userTookOver, settledTurnMessages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (retry budget spent, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      writeExitSidecar(
        process.env.PI_SUBAGENT_SESSION,
        findLatestAssistantError(settledTurnMessages),
      );

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  // The upward half of send_message. `parent` is the only recipient reachable
  // this way; a worker that can also spawn contributes the downward transports
  // from index.ts, and both land on one tool in that process.
  registerSendMessage(pi, "parent", [
    {
      known: () => (process.env.PI_SUBAGENT_SESSION ? [PARENT] : []),

      deliver(to, message) {
        if (to !== PARENT) return null;

        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        // Not spawned as a subagent, so there is no parent. Pass rather than
        // throw: the router reports no-parent, and a top-level session gets a
        // result it can act on instead of an aborted turn.
        if (!sessionFile) return null;

        // Keep the session open: suppress auto-exit for this turn and park in
        // the "waiting" phase. The parent's watcher picks up the `.message` signal
        // and notifies the orchestrator, who replies with send_message.
        awaitingReply = true;
        recorder.awaitReply();
        writeFileSync(
          `${sessionFile}.message`,
          JSON.stringify({
            name: process.env.PI_SUBAGENT_NAME ?? "subagent",
            agent: process.env.PI_SUBAGENT_AGENT ?? "",
            message,
          }),
        );

        return { status: "sent-to-parent" };
      },
    },
  ]);
}
