import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveness, SNAPSHOT_STALLED_AFTER_MS } from "../liveness.ts";
import { writeSubagentActivityFile, type SubagentActivityState } from "../activity.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "liveness-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An activity snapshot, defaulting to "mid-bash right now".
 *
 * The activity file is the only channel a subagent has for reporting itself, so
 * every test here drives the machine the way the real thing does.
 */
function activity(over: Partial<SubagentActivityState> = {}): SubagentActivityState {
  return {
    version: 1,
    runningChildId: "child-1",
    createdAt: 0,
    updatedAt: 0,
    sequence: 1,
    latestEvent: "tool_execution_start",
    phase: "active",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: true,
    activeScope: "tool",
    activeSince: 0,
    toolName: "bash",
    ...over,
  };
}

function makeLiveness(dir: string, opts: { interactive?: boolean; id?: string } = {}) {
  const id = opts.id ?? "child-1";
  const activityFile = join(dir, `activity-${id}.json`);
  return {
    activityFile,
    write: (over: Partial<SubagentActivityState> = {}) =>
      writeSubagentActivityFile(activityFile, activity({ runningChildId: id, ...over })),
    remove: () => rmSync(activityFile, { force: true }),
    liveness: createLiveness({
      id,
      name: "Worker",
      activityFile,
      startTimeMs: 0,
      interactive: opts.interactive ?? false,
    }),
  };
}

describe("liveness.ts", () => {
  describe("reading the activity file", () => {
    it("reports starting when no activity has been written yet", () => {
      withTempDir((dir) => {
        const { liveness } = makeLiveness(dir);
        liveness.observe(1_000);
        assert.equal(liveness.snapshot(1_000).kind, "starting");
      });
    });

    it("picks up the tool a subagent is running", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({ updatedAt: 5_000, activeSince: 5_000 });
        liveness.observe(5_000);

        const snapshot = liveness.snapshot(5_000);
        assert.equal(snapshot.kind, "active");
        assert.equal(snapshot.activityLabel, "bash");
      });
    });

    it("ignores an activity file belonging to a different child", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        // Same path, someone else's id: a stale file from a previous run.
        write({ runningChildId: "someone-else", updatedAt: 5_000 });
        liveness.observe(5_000);

        assert.notEqual(liveness.snapshot(5_000).kind, "active");
      });
    });

    it("survives a corrupt activity file", () => {
      withTempDir((dir) => {
        const { liveness, activityFile } = makeLiveness(dir);
        writeFileSync(activityFile, "not json{", "utf8");
        liveness.observe(5_000);
        assert.ok(liveness.snapshot(5_000).kind);
      });
    });
  });

  describe("classification", () => {
    it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
      withTempDir((dir) => {
        const { liveness } = makeLiveness(dir);
        liveness.observe(1_000);

        assert.equal(liveness.snapshot(1_000 + SNAPSHOT_STALLED_AFTER_MS - 1).kind, "starting");
        const stalled = liveness.snapshot(1_000 + SNAPSHOT_STALLED_AFTER_MS);
        assert.equal(stalled.kind, "stalled");
        assert.equal(stalled.statusLabel, null);
      });
    });

    it("classifies active snapshots without aging into stalled", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({ updatedAt: 5_000, activeSince: 5_000 });
        liveness.observe(5_000);

        const snapshot = liveness.snapshot(240_000);
        assert.equal(snapshot.kind, "active");
        assert.equal(snapshot.activityLabel, "bash");
        assert.equal(snapshot.activeDurationText, "3m");
      });
    });

    it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({
          updatedAt: 10_000,
          phase: "waiting",
          waitingSince: 10_000,
          latestEvent: "agent_end",
          activeScope: undefined,
          toolActive: false,
          turnActive: false,
        });
        liveness.observe(10_000);

        const snapshot = liveness.snapshot(240_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.waitingDurationText, "3m");
      });
    });

    it("reports a finished subagent as waiting, labelled done", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({
          updatedAt: 5_000,
          phase: "done",
          latestEvent: "session_shutdown",
          activeScope: undefined,
          agentActive: false,
          turnActive: false,
          toolActive: false,
        });
        liveness.observe(5_000);

        const snapshot = liveness.snapshot(5_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.statusLabel, "done");
      });
    });

    it("stalls a subagent that reports starting and never progresses", () => {
      withTempDir((dir) => {
        // Distinct from a missing file: the subagent is writing, it just never
        // gets past startup. The watchdog has to fire on the file's own claim.
        const { liveness, write } = makeLiveness(dir);
        write({
          updatedAt: 1_000,
          phase: "starting",
          latestEvent: "session_start",
          activeScope: undefined,
          turnActive: false,
          toolActive: false,
        });
        liveness.observe(1_000);

        assert.equal(liveness.snapshot(1_000).kind, "starting");
        assert.equal(liveness.snapshot(1_000 + SNAPSHOT_STALLED_AFTER_MS - 1).kind, "starting");
        assert.equal(liveness.snapshot(1_000 + SNAPSHOT_STALLED_AFTER_MS).kind, "stalled");
      });
    });

    it("stalls once a previously healthy subagent stops reporting for long enough", () => {
      withTempDir((dir) => {
        const { liveness, write, remove } = makeLiveness(dir);
        write({ updatedAt: 5_000, activeSince: 5_000 });
        liveness.tick(5_000);
        assert.equal(liveness.snapshot(5_000).kind, "active");

        remove();
        liveness.observe(6_000);
        assert.equal(liveness.snapshot(6_000).kind, "active", "brief loss holds the last healthy kind");

        assert.equal(
          liveness.snapshot(6_000 + SNAPSHOT_STALLED_AFTER_MS).kind,
          "stalled",
          "but stale knowledge has to expire",
        );
      });
    });

    it("keeps the last healthy kind during transient snapshot loss", () => {
      withTempDir((dir) => {
        const { liveness, write, remove } = makeLiveness(dir);
        write({ updatedAt: 5_000, activeScope: "streaming", activeSince: 5_000 });
        liveness.tick(5_000);

        remove();
        liveness.observe(10_000);

        const snapshot = liveness.snapshot(20_000);
        assert.equal(snapshot.kind, "active", "a brief read failure must not erase what we knew");
        assert.equal(snapshot.statusLabel, null);
      });
    });

    it("recovers from a transient read failure when the same snapshot comes back", () => {
      withTempDir((dir) => {
        const { liveness, write, remove } = makeLiveness(dir);
        const stable = { updatedAt: 5_000, sequence: 2, activeSince: 5_000 };
        write(stable);
        liveness.observe(5_000);

        remove();
        liveness.observe(10_000);
        assert.equal(liveness.snapshot(10_000).statusLabel, null);

        // Byte-identical to what we already folded in, so it must not be
        // rejected as stale on its way back.
        write(stable);
        liveness.observe(11_000);

        const snapshot = liveness.snapshot(11_000);
        assert.equal(snapshot.kind, "active");
        assert.equal(snapshot.statusLabel, null);
      });
    });
  });

  describe("ordering", () => {
    it("rejects a snapshot older than one already folded in", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({
          updatedAt: 10_000,
          sequence: 5,
          phase: "waiting",
          waitingSince: 10_000,
          latestEvent: "await_reply",
          activeScope: undefined,
          toolActive: false,
        });
        liveness.observe(10_000);
        assert.equal(liveness.snapshot(10_000).kind, "waiting");

        // A write that lost the race: strictly older, so it must not win.
        write({ updatedAt: 9_000, sequence: 4, activeSince: 9_000 });
        liveness.observe(11_000);
        assert.equal(liveness.snapshot(11_000).kind, "waiting", "an older snapshot must not resurrect active");

        // Same millisecond, lower sequence: also older, by the tiebreak.
        write({ updatedAt: 10_000, sequence: 4, activeSince: 10_000 });
        liveness.observe(12_000);
        assert.equal(liveness.snapshot(12_000).kind, "waiting", "sequence breaks the millisecond tie");
      });
    });

    it("orders same-millisecond snapshots by sequence", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({ updatedAt: 10_000, sequence: 2, activeSince: 10_000 });
        liveness.observe(10_000);

        write({
          updatedAt: 10_000,
          sequence: 3,
          phase: "waiting",
          waitingSince: 10_000,
          latestEvent: "agent_end",
          activeScope: undefined,
          toolActive: false,
        });
        liveness.observe(10_001);

        const snapshot = liveness.snapshot(11_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.latestEvent, "agent_end");
      });
    });
  });

  describe("interrupted", () => {
    it("moves an active subagent to waiting", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        write({ updatedAt: 5_000, activeSince: 5_000 });
        liveness.observe(5_000);
        assert.equal(liveness.snapshot(20_000).kind, "active");

        liveness.interrupted(20_000);

        const snapshot = liveness.snapshot(20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(snapshot.waitingDurationText, "0s");
        assert.equal(snapshot.activeScope, null);
        assert.equal(snapshot.activeSinceMs, null);
      });
    });

    it("ignores stale and same-timestamp snapshots afterwards, but accepts newer ones", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        const before = { updatedAt: 5_000, sequence: 1, activeSince: 5_000 };
        write(before);
        liveness.observe(5_000);
        liveness.interrupted(20_000);

        // In flight when we interrupted: older than the override, so it loses.
        write(before);
        liveness.observe(21_000);
        assert.equal(liveness.snapshot(21_000).kind, "waiting");
        assert.equal(liveness.snapshot(21_000).activityLabel, "interrupted");

        // Exactly the override timestamp at the same sequence: still loses.
        write({ updatedAt: 20_000, sequence: 1, activeSince: 20_000 });
        liveness.observe(22_000);
        assert.equal(liveness.snapshot(22_000).kind, "waiting");
        assert.equal(liveness.snapshot(22_000).activityLabel, "interrupted");

        // Genuinely newer: the subagent has picked the work back up.
        write({
          updatedAt: 25_000,
          sequence: 2,
          activeScope: "streaming",
          activeSince: 25_000,
          toolName: undefined,
        });
        liveness.observe(25_000);

        const snapshot = liveness.snapshot(25_000);
        assert.equal(snapshot.kind, "active");
        assert.equal(snapshot.activeScope, "streaming");
      });
    });
  });

  describe("tick", () => {
    it("reports no change and no transition while nothing is happening", () => {
      withTempDir((dir) => {
        const { liveness } = makeLiveness(dir);
        liveness.tick(1_000);
        assert.deepEqual(liveness.tick(2_000), { kindChanged: false, transition: null });
      });
    });

    it("flags a kind change so the widget can repaint", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        liveness.tick(1_000); // starting

        write({ updatedAt: 2_000, activeSince: 2_000 });
        assert.equal(liveness.tick(2_000).kindChanged, true);
        assert.equal(liveness.tick(2_100).kindChanged, false, "already active");
      });
    });

    it("produces a transition line once a subagent stalls", () => {
      withTempDir((dir) => {
        const { liveness } = makeLiveness(dir);
        liveness.tick(1_000);

        const stalled = liveness.tick(SNAPSHOT_STALLED_AFTER_MS + 2_000);
        assert.ok(stalled.transition, "expected a stalled transition line");
        assert.match(stalled.transition, /Worker/);
        assert.match(stalled.transition, /stalled/i);

        assert.equal(
          liveness.tick(SNAPSHOT_STALLED_AFTER_MS + 3_000).transition,
          null,
          "a transition fires once, not on every tick",
        );
      });
    });

    it("announces recovery once the subagent reports again", () => {
      withTempDir((dir) => {
        const { liveness, write } = makeLiveness(dir);
        liveness.tick(1_000);
        assert.match(liveness.tick(95_000).transition ?? "", /stalled/i);

        write({
          updatedAt: 96_000,
          phase: "waiting",
          waitingSince: 96_000,
          latestEvent: "agent_end",
          activeScope: undefined,
          toolActive: false,
        });

        const recovered = liveness.tick(97_000);
        assert.match(recovered.transition ?? "", /recovered/i);
        assert.equal(liveness.snapshot(97_000).kind, "waiting");
      });
    });

    it("suppresses the transition for an interactive subagent", () => {
      withTempDir((dir) => {
        // The user is already watching this pane; a "still waiting" steer would
        // burn an orchestrator turn on a no-op.
        const { liveness } = makeLiveness(dir, { interactive: true });
        liveness.tick(1_000);

        const stalled = liveness.tick(SNAPSHOT_STALLED_AFTER_MS + 2_000);
        assert.equal(stalled.transition, null, "interactive transitions stay local");
        assert.equal(stalled.kindChanged, true, "but the widget still repaints");
      });
    });
  });
});
