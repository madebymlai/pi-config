/**
 * What a running subagent's status looks like, as a value.
 *
 * This is the vocabulary observe/liveness.ts produces and render/ consumes, so it
 * lives with the producer. It used to live in render/status.ts, which meant the
 * observation layer imported its own domain types from the render layer.
 * formatElapsedDuration was the clearest symptom of that: defined over there,
 * never called over there, exported solely so liveness could reach it.
 *
 * A vocabulary module's exports are its content, so the usual advice about
 * narrowing an interface does not apply here. What matters is direction: nothing
 * under observe/ may import from render/, and this is what makes that possible.
 *
 * StatusSnapshot deliberately carries pre-formatted *Text fields beside the raw
 * *Ms ones. It is a view model, built once by the machine and read by several
 * renderers, which is why the duration formatter belongs on this side.
 */

/**
 * The status machine's nodes, S0 first. The list is the source of truth and the
 * type derives from it, so the two cannot drift apart.
 *
 * Every node here must be reachable from S0 by some sequence of observations;
 * test/reachability.test.ts proves that by exploring the state space. That test
 * is what caught the "running" node, which nothing had been able to produce for
 * a long time while three call sites still rendered it.
 */
/**
 * Stamped on a snapshot when the subagent has finished and is shutting down.
 *
 * "done" is not a kind. The kinds answer "is it busy?", and a finished subagent
 * and one blocked on a reply are both not busy, so both classify as "waiting".
 * The distinction that matters lives one layer down in SubagentActivityPhase,
 * which has its own "done". This label is how the two are told apart for
 * display, and renderers must let it replace the word "waiting" rather than
 * decorate it: "waiting, done" reads as a contradiction.
 */
export const DONE_LABEL = "done";

export const SUBAGENT_STATUS_KINDS = ["starting", "active", "waiting", "stalled"] as const;

export type SubagentStatusKind = (typeof SUBAGENT_STATUS_KINDS)[number];

/** The transitions worth waking a parent for. Same reachability rule applies. */
export const SUBAGENT_STATUS_TRANSITIONS = ["stalled", "recovered"] as const;

export type SubagentStatusTransition = (typeof SUBAGENT_STATUS_TRANSITIONS)[number] | null;

export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";

export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}
