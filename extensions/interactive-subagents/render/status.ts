import type {
  StatusSnapshot,
  SubagentStatusTransition,
} from "../observe/status-snapshot.ts";

const MAX_STATUS_NAME_LENGTH = 72;
const MAX_STATUS_LINE_LENGTH = 120;

interface StatusDigest {
  /** What to send as the message body. */
  content: string;
  /** Exactly the lines `content` shows, for the renderer to lay out. */
  visibleLines: string[];
  /** How many were left out, already stated in `content`. */
  overflow: number;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`);
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel && snapshot.statusLabel !== "done"
      ? ` (${snapshot.statusLabel})`
      : snapshot.statusLabel === "done"
        ? " (done)"
        : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`);
  }

  return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`);
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

/**
 * One status digest: the text to steer with, and the lines it was built from.
 *
 * These come back together because they have to agree. The caller used to cap
 * the lines itself for the message details and then hand the same uncapped list
 * and the same limit to a separate formatter for the message content, trusting
 * the two to cap identically. Nothing enforced that, and a divergence would have
 * shown a box listing different subagents than the sentence beside it.
 */
export function renderStatusDigest(lines: string[], lineLimit: number): StatusDigest {
  const visibleLines = lines.slice(0, lineLimit);
  const overflow = Math.max(0, lines.length - visibleLines.length);

  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);

  return { visibleLines, overflow, content: `Subagent status:\n${bulletLines.join("\n")}` };
}
