import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceStatusState,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  observeStatus,
  SUBAGENT_STATUS_KINDS,
  SUBAGENT_STATUS_TRANSITIONS,
  type StatusObservation,
  type SubagentStatusState,
} from "../status.ts";

/**
 * Reachability analysis over the status machine.
 *
 * A declared node the code can never produce is dead weight that still has to be
 * rendered, tested and reasoned about at every call site. Nothing catches that by
 * reading the code, because the dead node looks exactly like a live one. So this
 * explores the state space from S0 and asserts every declared node and transition
 * actually shows up.
 *
 * A stricter adjacency model was considered and rejected on measurement: the
 * relation here is complete (every kind can legally follow every kind), so a
 * transition table would forbid nothing. Reachability is the half that pays.
 */

/** Every observation shape the type admits. */
const OBSERVATIONS: StatusObservation[] = [];
for (const snapshot of ["missing", "invalid", "wrong-id"] as const) {
  OBSERVATIONS.push({ snapshot });
}
for (const phase of ["starting", "active", "waiting", "done"] as const) {
  for (const activeScope of ["tool", undefined]) {
    for (const active of [true, false, undefined]) {
      OBSERVATIONS.push({ snapshot: "present", updatedAt: 0, sequence: 0, phase, activeScope, active });
    }
  }
}

/** Long enough to cross SNAPSHOT_STALLED_AFTER_MS, short enough to stay under it. */
const CLOCK_STEPS = [0, 1_000, 61_000];

/**
 * Collapse a state to what classification actually reads, so the walk terminates.
 * Timestamps would otherwise make the space infinite.
 */
function abstractState(state: SubagentStatusState) {
  return JSON.stringify([
    state.currentKind,
    state.phase,
    state.snapshotState,
    state.activeNow,
    state.lastActivityAtMs != null,
    state.waitingSinceMs != null,
    state.snapshotProblemSinceMs != null,
    state.localOverrideAtMs != null,
  ]);
}

function explore() {
  const kinds = new Set<string>();
  const transitions = new Set<string>();
  const visited = new Set<string>();
  let frontier = [{ state: createStatusState({ startTimeMs: 0 }), now: 0 }];

  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { state, now } of frontier) {
      const key = abstractState(state);
      if (visited.has(key)) continue;
      visited.add(key);
      kinds.add(classifyStatus(state, now).kind);

      for (const step of CLOCK_STEPS) {
        const at = now + step;
        const advanced = advanceStatusState(state, at);
        if (advanced.transition) transitions.add(advanced.transition);

        next.push({ state: advanced.nextState, now: at });
        next.push({ state: forceStatusAfterInterrupt(state, at), now: at });
        for (const observation of OBSERVATIONS) {
          const dated =
            observation.snapshot === "present"
              ? { ...observation, updatedAt: at, sequence: at }
              : observation;
          next.push({ state: observeStatus(state, dated, at), now: at });
        }
      }
    }
    frontier = next;
  }

  return { kinds, transitions, visited: visited.size };
}

describe("status machine reachability", () => {
  const { kinds, transitions, visited } = explore();

  it("explores a non-trivial slice of the state space", () => {
    assert.ok(visited > 100, `only ${visited} states explored; the walk stopped short`);
  });

  it("starts at S0", () => {
    assert.equal(createStatusState({ startTimeMs: 0 }).currentKind, SUBAGENT_STATUS_KINDS[0]);
  });

  for (const kind of SUBAGENT_STATUS_KINDS) {
    it(`can reach the ${kind} node`, () => {
      assert.ok(
        kinds.has(kind),
        `"${kind}" is declared but nothing can produce it. Either it is dead and should ` +
          `be removed from SUBAGENT_STATUS_KINDS and its render sites, or the observation ` +
          `that produces it is missing from this walk.`,
      );
    });
  }

  for (const transition of SUBAGENT_STATUS_TRANSITIONS) {
    it(`can reach the ${transition} transition`, () => {
      assert.ok(transitions.has(transition), `"${transition}" is declared but never fires.`);
    });
  }
});
