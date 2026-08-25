import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveness, SNAPSHOT_STALLED_AFTER_MS } from "../liveness.ts";
import { SUBAGENT_STATUS_KINDS, SUBAGENT_STATUS_TRANSITIONS } from "../status.ts";
import { writeSubagentActivityFile, type SubagentActivityState } from "../activity.ts";

/**
 * Reachability analysis over the status machine.
 *
 * A declared node nothing can produce is dead weight that still has to be
 * rendered, tested and reasoned about at every call site, and reading the code
 * will not find it: a dead node looks exactly like a live one. So this drives
 * the machine over every short sequence of inputs and asserts that each declared
 * node and transition actually shows up.
 *
 * It drives through the activity file rather than poking state, because that is
 * the only channel a real subagent has. A node reachable only via some state
 * shape the recorder can never write is still dead in practice, and this way the
 * test cannot claim otherwise.
 *
 * A stricter adjacency model was considered and rejected on measurement: the
 * relation here is complete, so a table of legal pairs would forbid nothing.
 * Reachability is the half that pays.
 */

const CHILD_ID = "child-1";

/** What the subagent's activity file says at a given step, including saying nothing. */
type FileState = "absent" | "corrupt" | "wrong-id" | "starting" | "active" | "waiting" | "done";

const FILE_STATES: FileState[] = ["absent", "corrupt", "wrong-id", "starting", "active", "waiting", "done"];

/** Small stays under the watchdog; large crosses it. */
const CLOCK_STEPS = [1_000, SNAPSHOT_STALLED_AFTER_MS + 1_000];

interface Action {
  file: FileState | null;
  interrupt: boolean;
  step: number;
}

const ACTIONS: Action[] = [
  ...FILE_STATES.flatMap((file) => CLOCK_STEPS.map((step) => ({ file, interrupt: false, step }))),
  ...CLOCK_STEPS.map((step) => ({ file: null, interrupt: true, step })),
];

function activityFor(state: FileState, at: number, sequence: number): SubagentActivityState {
  const base = {
    version: 1,
    runningChildId: state === "wrong-id" ? "someone-else" : CHILD_ID,
    createdAt: 0,
    updatedAt: at,
    sequence,
    agentActive: true,
    turnActive: state === "active",
    providerActive: false,
    toolActive: state === "active",
  } as const;

  if (state === "active") {
    return { ...base, phase: "active", latestEvent: "tool_execution_start", activeScope: "tool", activeSince: at, toolName: "bash" };
  }
  if (state === "waiting") {
    return { ...base, phase: "waiting", latestEvent: "await_reply", waitingSince: at };
  }
  if (state === "done") {
    return { ...base, phase: "done", latestEvent: "session_shutdown" };
  }
  return { ...base, phase: "starting", latestEvent: "session_start" };
}

/** Run one sequence on a fresh machine, reporting everything it produced. */
function run(sequence: Action[], activityFile: string) {
  const kinds: string[] = [];
  const transitions: string[] = [];
  const liveness = createLiveness({
    id: CHILD_ID,
    name: "Worker",
    activityFile,
    startTimeMs: 0,
    interactive: false,
  });

  let now = 0;
  let writes = 0;
  for (const action of sequence) {
    if (action.file === "absent") rmSync(activityFile, { force: true });
    else if (action.file === "corrupt") writeFileSync(activityFile, "not json{", "utf8");
    else if (action.file) writeSubagentActivityFile(activityFile, activityFor(action.file, now, ++writes));

    now += action.step;

    if (action.interrupt) {
      liveness.interrupted(now);
    } else {
      const line = liveness.tick(now).transition;
      // tick reports a formatted line; recover the transition it was built from.
      if (line) transitions.push(/recovered/i.test(line) ? "recovered" : "stalled");
    }
    kinds.push(liveness.snapshot(now).kind);
  }

  return { kinds, transitions };
}

function explore(maxLength: number) {
  const dir = mkdtempSync(join(tmpdir(), "reachability-"));
  const activityFile = join(dir, "activity.json");
  const kinds = new Set<string>();
  const transitions = new Set<string>();
  let sequences = 0;

  try {
    let frontier: Action[][] = [[]];
    for (let length = 1; length <= maxLength; length++) {
      const next: Action[][] = [];
      for (const prefix of frontier) {
        for (const action of ACTIONS) {
          const sequence = [...prefix, action];
          next.push(sequence);
          sequences++;
          const result = run(sequence, activityFile);
          for (const kind of result.kinds) kinds.add(kind);
          for (const transition of result.transitions) transitions.add(transition);
        }
      }
      frontier = next;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return { kinds, transitions, sequences };
}

describe("status machine reachability", () => {
  const { kinds, transitions, sequences } = explore(3);

  it("explores a non-trivial slice of the input space", () => {
    assert.ok(sequences > 1_000, `only ${sequences} sequences run; the walk stopped short`);
  });

  it("starts at S0", () => {
    const dir = mkdtempSync(join(tmpdir(), "reachability-s0-"));
    try {
      const liveness = createLiveness({
        id: CHILD_ID,
        name: "Worker",
        activityFile: join(dir, "activity.json"),
        startTimeMs: 0,
        interactive: false,
      });
      assert.equal(liveness.snapshot(0).kind, SUBAGENT_STATUS_KINDS[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const kind of SUBAGENT_STATUS_KINDS) {
    it(`can reach the ${kind} node`, () => {
      assert.ok(
        kinds.has(kind),
        `"${kind}" is declared but no sequence of activity-file states produces it. Either ` +
          `it is dead and should be removed from SUBAGENT_STATUS_KINDS and its render sites, ` +
          `or the input that produces it is missing from this walk.`,
      );
    });
  }

  for (const transition of SUBAGENT_STATUS_TRANSITIONS) {
    it(`can reach the ${transition} transition`, () => {
      assert.ok(transitions.has(transition), `"${transition}" is declared but never fires.`);
    });
  }
});
