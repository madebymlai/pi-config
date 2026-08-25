import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSubagentActivityRecorder,
  type SubagentActivityRecorder,
} from "../child/activity-recorder.ts";
import { KNOWN_EVENTS, KNOWN_PHASES, KNOWN_SCOPES } from "../protocol/activity.ts";
import { readSubagentActivityFile } from "../observe/activity-reader.ts";
import { createLiveness, SNAPSHOT_STALLED_AFTER_MS } from "../observe/liveness.ts";
import { SUBAGENT_STATUS_KINDS } from "../observe/status-snapshot.ts";

/**
 * The contract between the two processes, exercised end to end.
 *
 * Three modules share one format and none of them talk to each other: a subagent
 * writes through child/activity-recorder.ts, the parent validates through
 * observe/activity-reader.ts, and observe/liveness.ts classifies the result. Each
 * has its own tests, and every one of those tests supplies its own input.
 *
 * That leaves the interesting question unasked. liveness's reachability walk
 * proves every status node is reachable from activity files, but the files in
 * that walk are written by the test. If the recorder cannot actually produce a
 * shape, a node reachable only through that shape is dead in practice and the
 * walk would still call it live.
 *
 * So this drives the real recorder, reads with the real reader, and classifies
 * with the real machine. Nothing here writes an activity file by hand.
 */

const CHILD_ID = "child-1";

/** Every way a pi session can move its recorder, named as the event it emits. */
const MOVES: Array<[string, (recorder: SubagentActivityRecorder) => void]> = [
  ["session_start", (r) => r.sessionStart()],
  ["input", (r) => r.input()],
  ["before_agent_start", (r) => r.beforeAgentStart()],
  ["agent_start", (r) => r.agentStart()],
  ["agent_end/waiting", (r) => r.agentEndWaiting()],
  ["agent_end/done", (r) => r.agentEndDone()],
  ["turn_start", (r) => r.turnStart(1)],
  ["turn_end", (r) => r.turnEnd(1)],
  ["before_provider_request", (r) => r.beforeProviderRequest()],
  ["after_provider_response", (r) => r.afterProviderResponse()],
  ["message_update", (r) => r.messageUpdate("text")],
  ["tool_execution_start", (r) => r.toolExecutionStart("call-1", "bash")],
  ["tool_call", (r) => r.toolCall("call-1", "bash")],
  ["tool_execution_update", (r) => r.toolExecutionUpdate("call-1", "bash")],
  ["tool_result", (r) => r.toolResult("call-1", "bash")],
  ["tool_execution_end", (r) => r.toolExecutionEnd("call-1", "bash")],
  ["await_reply", (r) => r.awaitReply()],
  ["session_shutdown/quit", (r) => r.sessionShutdown("quit")],
  ["session_shutdown/reload", (r) => r.sessionShutdown("reload")],
];

interface Observed {
  events: Set<string>;
  phases: Set<string>;
  scopes: Set<string>;
  kinds: Set<string>;
  rejected: string[];
}

/**
 * Run every ordered pair of moves on a fresh recorder, reading the file back
 * after each one. Pairs rather than singles because scope resolution depends on
 * what was already active: a tool ending only reveals the turn beneath it.
 */
function explore(): Observed {
  const dir = mkdtempSync(join(tmpdir(), "roundtrip-"));
  const seen: Observed = {
    events: new Set(), phases: new Set(), scopes: new Set(), kinds: new Set(), rejected: [],
  };

  try {
    let index = 0;
    for (const [firstName, first] of MOVES) {
      for (const [secondName, second] of MOVES) {
        const activityFile = join(dir, `activity-${index++}.json`);
        let clock = 1_000;
        const recorder = createSubagentActivityRecorder({
          runningChildId: CHILD_ID,
          activityFile,
          now: () => clock,
        });
        const liveness = createLiveness({
          id: CHILD_ID, activityFile, startTimeMs: 0, interactive: false,
        });

        for (const [name, move] of [[firstName, first], [secondName, second]] as const) {
          move(recorder);
          clock += 5_000;

          const read = readSubagentActivityFile(activityFile, CHILD_ID);
          if (!read.ok) {
            // "missing" is legitimate: a disabled recorder writes nothing.
            if (read.reason !== "missing") {
              seen.rejected.push(`${firstName} then ${secondName}: ${name} produced ${read.reason}`);
            }
            continue;
          }

          seen.events.add(read.activity.latestEvent);
          seen.phases.add(read.activity.phase);
          if (read.activity.activeScope) seen.scopes.add(read.activity.activeScope);

          liveness.observe(clock);
          seen.kinds.add(liveness.snapshot(clock).kind);
        }

        // Nothing more will be written, so the parent must eventually call it stalled.
        liveness.observe(clock);
        seen.kinds.add(liveness.snapshot(clock + SNAPSHOT_STALLED_AFTER_MS * 2).kind);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return seen;
}

describe("activity round trip: recorder -> file -> reader -> liveness", () => {
  const seen = explore();

  it("never writes a file its own reader rejects", () => {
    assert.deepEqual(
      seen.rejected, [],
      "the recorder produced output the reader refused, so the two have drifted apart",
    );
  });

  for (const phase of KNOWN_PHASES) {
    it(`the recorder can actually produce the ${phase} phase`, () => {
      assert.ok(
        seen.phases.has(phase),
        `"${phase}" is a declared phase that no sequence of session events produces. ` +
          `Either it is dead, or the event that reaches it is missing from MOVES.`,
      );
    });
  }

  for (const scope of KNOWN_SCOPES) {
    it(`the recorder can actually produce the ${scope} scope`, () => {
      assert.ok(
        seen.scopes.has(scope),
        `"${scope}" is a declared scope that no sequence of session events produces.`,
      );
    });
  }

  for (const kind of SUBAGENT_STATUS_KINDS) {
    it(`the ${kind} status is reachable from real recorder output`, () => {
      assert.ok(
        seen.kinds.has(kind),
        `"${kind}" is reachable in the synthetic reachability walk but not from any file ` +
          `the recorder actually writes, which would make it dead in practice.`,
      );
    });
  }

  it("emits every declared activity event", () => {
    const missing = [...KNOWN_EVENTS].filter((event) => !seen.events.has(event));
    assert.deepEqual(missing, [], "declared events that no recorder method emits");
  });
});
