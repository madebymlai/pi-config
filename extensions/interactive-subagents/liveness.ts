/**
 * How a running subagent is doing, and nothing else about it.
 *
 * Before this module the status state was a mutable field on RunningSubagent
 * poked from five places. Each one had to know which of status.ts's functions
 * applied, and — the part that bites — that every one of them returns a NEW
 * state you must assign back. Forgetting the assignment loses the observation
 * silently, and there is nothing in the type system to catch it.
 *
 * The four verbs below are what those five callers actually wanted. Behind them
 * sit the activity file, the ten-field observation mapping, four status.ts
 * functions, and the assign-back discipline. A caller learns the verbs; it does
 * not learn that any of that exists.
 *
 * `interactive` lives in here too, because it is a liveness policy: it decides
 * only whether a transition is worth waking the parent for, and no caller
 * outside this module has any other use for it.
 */
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  advanceStatusState,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatTransitionLine,
  observeStatus,
  type StatusSnapshot,
  type SubagentStatusState,
} from "./status.ts";

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
    if (activity.activeScope === "tool") return activity.toolName ?? "tool";
    if (activity.activeScope === "provider") return "provider";
    if (activity.activeScope === "streaming") return "streaming";
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
        active: read.activity.phase === "active",
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
