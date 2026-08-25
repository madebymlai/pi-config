/**
 * How a running subagent is doing, and nothing else about it.
 *
 * This module owns the status machine outright: the state type, the observation
 * fold, and the classification all live below as module-private code, and no
 * state value is exported. That is deliberate. While the state was an exported
 * record, `{ ...state, currentKind: "active" }` was a thing any caller could
 * write; the module itself did exactly that in the interrupt path, and nothing
 * would have stopped a caller copying it. Now the state cannot leave here, and
 * the only way in is the four verbs on SubagentLiveness.
 *
 * status.ts keeps what is genuinely shared: the snapshot value type the widget
 * renders, the line formatting, and config loading. It has no state of its own.
 *
 * `interactive` lives in here too, because it is a liveness policy: it decides
 * only whether a transition is worth waking the parent for, and no caller
 * outside this module has any other use for it.
 */
import { readSubagentActivityFile, type ActivityReadResult } from "./activity-reader.ts";
import {
  getSubagentActivityFile,
  type SubagentActivityState,
} from "./activity-schema.ts";
import {
  formatElapsedDuration,
  formatTransitionLine,
  SUBAGENT_STATUS_KINDS,
  type StatusActivityPhase,
  type StatusSnapshot,
  type StatusSnapshotState,
  type SubagentStatusKind,
  type SubagentStatusTransition,
} from "./status.ts";

/** How long without a healthy snapshot before a subagent counts as stalled. */
export const SNAPSHOT_STALLED_AFTER_MS = 60_000;

type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: StatusActivityPhase;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

interface SubagentStatusState {
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: StatusActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  /** Written only by advance. See the note there. */
  readonly currentKind: SubagentStatusKind;
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

/**
 * The only transition, and it takes no destination.
 *
 * A status is not something a caller picks: it is whatever the current evidence
 * classifies to. Taking the kind as a parameter would make this a setter wearing
 * a better name, since any caller could name any kind and it would be written.
 * Deriving it here means the wrong status is not something you can ask for.
 *
 * That also settles the adjacency question. A table of legal pairs was measured
 * and came back complete (test/reachability.test.ts), so it would have forbidden
 * nothing. With no destination parameter an illegal edge is not expressible at
 * all, which is the stronger result and costs nothing to keep in sync.
 *
 * Apart from createStatusState establishing S0, this is the only place
 * currentKind is written, and the state type does not leave this module.
 */
function advance(state: SubagentStatusState, now: number) {
  const snapshot = classifyStatus(state, now);
  return {
    snapshot,
    state: snapshot.kind === state.currentKind ? state : { ...state, currentKind: snapshot.kind },
  };
}

function createStatusState(params: { startTimeMs: number }): SubagentStatusState {
  return {
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    // S0, taken from the declared node list rather than repeated as a literal.
    currentKind: SUBAGENT_STATUS_KINDS[0],
  };
}

function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity = lastActivityAtMs != null && (
    updatedAt < lastActivityAtMs ||
    (updatedAt === lastActivityAtMs && lastActivitySequence != null && sequence < lastActivitySequence)
  );
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride = state.localOverrideAtMs != null && (
    updatedAt < state.localOverrideAtMs ||
    (updatedAt === state.localOverrideAtMs && state.localOverrideSequence != null && sequence <= state.localOverrideSequence)
  );
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const isActive = phase === "active";
  const activeSinceMs = isActive
    ? observation.activeSince ?? state.activeSinceMs ?? updatedAt
    : null;
  const waitingSinceMs = phase === "waiting"
    ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt
    : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeSinceMs,
    activeScope: isActive ? observation.activeScope ?? null : null,
    waitingSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

/**
 * The parent just steered this subagent, so it is waiting on the parent by
 * definition rather than by observation.
 *
 * This is a real transition to "waiting", but a self-inflicted one, so it must
 * not be reported back to the parent as news. That falls out structurally: only
 * advanceStatusState returns transitions, and this path rebaselines the machine
 * without going through it. Skipping the rebaseline instead would make the next
 * tick announce a "recovered" that the parent itself caused.
 */
function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
  const interrupted: SubagentStatusState = {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    phase: "waiting",
    latestEvent: "interrupt_requested",
    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
  };

  return advance(interrupted, now).state;
}

function classifyProblemState(state: SubagentStatusState, now: number): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) return { kind: "stalled", statusLabel: problemLabel };

  const lastHealthyKind = state.phase === "active"
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel };
}

function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active") {
      kind = "active";
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind = elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS ? "stalled" : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText = state.activeSinceMs == null
    ? null
    : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText = state.waitingSinceMs == null
    ? null
    : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText = state.snapshotProblemSinceMs == null
    ? null
    : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const { snapshot, state: nextState } = advance(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return { snapshot, transition, nextState };
}

export interface SubagentLiveness {
  /** Fold in the latest activity snapshot. Cheap; safe to call every tick. */
  observe(now: number): void;
  /**
   * Observe, then advance time-based transitions.
   *
   * `kindChanged` means the widget needs a repaint. `transition` is the line to
   * steer the parent with, or null — null both when nothing changed and when
   * this subagent is interactive, since the user is already watching its pane
   * and a "still waiting" ping would burn an orchestrator turn on a no-op.
   *
   * Only one ticker may call this: advancing from two places would let a single
   * transition fire twice.
   */
  tick(now: number): { kindChanged: boolean; transition: string | null };
  /** The parent just steered this subagent, so it is no longer idle. */
  interrupted(now: number): void;
  /** Current classified status, for rendering. */
  snapshot(now: number): StatusSnapshot;
}

export function createLiveness(params: {
  /** Identifies whose activity file this is; a mismatched id reads as missing. */
  id: string;
  name: string;
  activityFile: string;
  startTimeMs: number;
  /** Interactive subagents are user-driven, so transitions stay local. */
  interactive: boolean;
}): SubagentLiveness {
  let state: SubagentStatusState = createStatusState({ startTimeMs: params.startTimeMs });

  /** The label shown while a subagent is mid-tool, or undefined when it is not. */
  const activityLabel = (activity: SubagentActivityState): string | undefined => {
    if (activity.phase !== "active") return undefined;
    // Only "tool" carries a name worth surfacing; every other scope already
    // reads as its own label. Mutation testing found the per-scope branches
    // that used to sit here were unreachable: the fallthrough returned the
    // identical string, so flipping their conditions changed nothing.
    if (activity.activeScope === "tool") return activity.toolName ?? "tool";
    return activity.activeScope;
  };

  const observe = (now: number) => {
    const read: ActivityReadResult = readSubagentActivityFile(params.activityFile, params.id);

    if (!read.ok) {
      state = observeStatus(state, { snapshot: read.reason, snapshotError: read.error }, now);
      return;
    }

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      },
      now,
    );
  };

  return {
    observe,

    tick(now) {
      observe(now);
      const previousKind = state.currentKind;
      const { nextState, snapshot, transition } = advanceStatusState(state, now);
      state = nextState;

      return {
        kindChanged: nextState.currentKind !== previousKind,
        transition:
          transition && !params.interactive
            ? formatTransitionLine(params.name, snapshot, transition)
            : null,
      };
    },

    interrupted(now) {
      state = forceStatusAfterInterrupt(state, now);
    },

    snapshot(now) {
      return classifyStatus(state, now);
    },
  };
}

export { getSubagentActivityFile };
