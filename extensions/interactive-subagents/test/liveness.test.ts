import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveness } from "../liveness.ts";
import { SNAPSHOT_STALLED_AFTER_MS } from "../status.ts";
import { writeSubagentActivityFile } from "../activity.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "liveness-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An activity snapshot saying the subagent is mid-`bash` as of `at`. */
function activeAt(id: string, at: number) {
  return {
    version: 1,
    runningChildId: id,
    createdAt: 0,
    updatedAt: at,
    sequence: 1,
    latestEvent: "tool_execution_start",
    phase: "active",
    activeScope: "tool",
    activeSince: at,
    toolName: "bash",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: true,
  } as any;
}

function makeLiveness(dir: string, opts: { interactive?: boolean; id?: string } = {}) {
  const id = opts.id ?? "child-1";
  const activityFile = join(dir, `activity-${id}.json`);
  return {
    activityFile,
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
  describe("observe", () => {
    it("reports starting when no activity has been written yet", () => {
      withTempDir((dir) => {
        const { liveness } = makeLiveness(dir);
        liveness.observe(1_000);
        assert.equal(liveness.snapshot(1_000).kind, "starting");
      });
    });

    it("picks up the tool a subagent is running", () => {
      withTempDir((dir) => {
        const { liveness, activityFile } = makeLiveness(dir);
        writeSubagentActivityFile(activityFile, activeAt("child-1", 5_000));
        liveness.observe(5_000);

        const snapshot = liveness.snapshot(5_000);
        assert.equal(snapshot.kind, "active");
        assert.equal(snapshot.activityLabel, "bash");
      });
    });

    it("ignores an activity file belonging to a different child", () => {
      withTempDir((dir) => {
        const { liveness, activityFile } = makeLiveness(dir);
        // Same path, someone else's id — a stale file from a previous run.
        writeSubagentActivityFile(activityFile, activeAt("someone-else", 5_000));
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

  describe("interrupted", () => {
    it("moves an active subagent to waiting", () => {
      withTempDir((dir) => {
        const { liveness, activityFile } = makeLiveness(dir);
        writeSubagentActivityFile(activityFile, activeAt("child-1", 5_000));
        liveness.observe(5_000);
        assert.equal(liveness.snapshot(5_000).kind, "active");

        liveness.interrupted(20_000);

        assert.equal(liveness.snapshot(20_000).kind, "waiting");
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
        const { liveness, activityFile } = makeLiveness(dir);
        liveness.tick(1_000); // starting

        writeSubagentActivityFile(activityFile, activeAt("child-1", 2_000));
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
        assert.match(stalled.transition!, /Worker/);
        assert.match(stalled.transition!, /stalled/i);

        assert.equal(
          liveness.tick(SNAPSHOT_STALLED_AFTER_MS + 3_000).transition,
          null,
          "a transition fires once, not on every tick",
        );
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
