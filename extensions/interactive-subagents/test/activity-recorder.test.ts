import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSubagentActivityRecorder } from "../child/activity-recorder.ts";
import type { SubagentActivityState } from "../protocol/activity.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "recorder-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A recorder on a controlled clock, plus a way to read back what it wrote.
 *
 * The clock is injected rather than stubbed globally because the recorder already
 * accepts one. Throttling is a function of that clock, so with it under test
 * control the throttle is deterministic instead of a sleep.
 */
function makeRecorder(dir: string, opts: { file?: string } = {}) {
  const activityFile = opts.file ?? join(dir, "activity.json");
  let clock = 1_000;
  return {
    activityFile,
    advance: (ms: number) => (clock += ms),
    at: () => clock,
    recorder: createSubagentActivityRecorder({
      runningChildId: "child-1",
      activityFile,
      now: () => clock,
    }),
    read: (): SubagentActivityState | null =>
      existsSync(activityFile)
        ? (JSON.parse(readFileSync(activityFile, "utf8")) as SubagentActivityState)
        : null,
  };
}

describe("child/activity-recorder.ts", () => {
  describe("configuration", () => {
    it("records nothing at all when it has no child id", () => {
      withTempDir((dir) => {
        const activityFile = join(dir, "activity.json");
        const recorder = createSubagentActivityRecorder({ activityFile });
        recorder.sessionStart();
        recorder.agentStart();
        assert.equal(existsSync(activityFile), false, "an unidentified recorder must stay silent");
      });
    });

    it("records nothing at all when it has nowhere to write", () => {
      withTempDir(() => {
        const recorder = createSubagentActivityRecorder({ runningChildId: "child-1" });
        // The point is that this does not throw.
        recorder.sessionStart();
        recorder.toolExecutionStart("call-1", "bash");
        recorder.sessionShutdown("quit");
      });
    });

    it("treats blank strings as absent rather than as a path", () => {
      withTempDir(() => {
        const recorder = createSubagentActivityRecorder({ runningChildId: "  ", activityFile: "  " });
        recorder.sessionStart();
      });
    });
  });

  describe("phase", () => {
    it("starts in the starting phase", () => {
      withTempDir((dir) => {
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();

        const activity = read();
        assert.equal(activity?.phase, "starting");
        assert.equal(activity?.latestEvent, "session_start");
        assert.equal(activity?.runningChildId, "child-1");
      });
    });

    it("goes active once the agent starts", () => {
      withTempDir((dir) => {
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();

        assert.equal(read()?.phase, "active");
        assert.equal(read()?.activeScope, "agent");
      });
    });

    it("parks in waiting, with a timestamp, when the agent yields", () => {
      withTempDir((dir) => {
        const { recorder, read, advance, at } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        advance(5_000);
        recorder.agentEndWaiting();

        const activity = read();
        assert.equal(activity?.phase, "waiting");
        assert.equal(activity?.waitingSince, at());
        assert.equal(activity?.activeScope, undefined, "waiting is not busy");
      });
    });

    it("parks in waiting when the subagent blocks on its parent", () => {
      withTempDir((dir) => {
        // await_reply must NOT disable the recorder: the reply will come, and
        // the parent needs to keep seeing this subagent until it does.
        const { recorder, read, advance } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.awaitReply();
        assert.equal(read()?.phase, "waiting");

        advance(1_000);
        recorder.agentStart();
        assert.equal(read()?.phase, "active", "recording resumes when the reply lands");
      });
    });

    it("stops recording once the run is done", () => {
      withTempDir((dir) => {
        const { recorder, read, advance } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.agentEndDone();
        assert.equal(read()?.phase, "done");

        // Anything after done is not this run's business.
        advance(1_000);
        recorder.agentStart();
        assert.equal(read()?.phase, "done", "a finished recorder stays finished");
      });
    });

    it("marks done on quit, but only disables on a reload", () => {
      withTempDir((dir) => {
        const quit = makeRecorder(dir, { file: join(dir, "quit.json") });
        quit.recorder.sessionStart();
        quit.recorder.sessionShutdown("quit");
        assert.equal(quit.read()?.phase, "done");

        const reload = makeRecorder(dir, { file: join(dir, "reload.json") });
        reload.recorder.sessionStart();
        reload.recorder.agentStart();
        reload.recorder.sessionShutdown("reload");
        assert.equal(reload.read()?.phase, "active", "a reload is not the run ending");
      });
    });
  });

  describe("active scope", () => {
    it("reports the tool a subagent is running, and clears it when the tool ends", () => {
      withTempDir((dir) => {
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.turnStart(1);
        recorder.toolExecutionStart("call-1", "bash");

        let activity = read();
        assert.equal(activity?.activeScope, "tool");
        assert.equal(activity?.toolName, "bash");
        assert.equal(activity?.toolCallId, "call-1");

        recorder.toolExecutionEnd("call-1", "bash");
        activity = read();
        assert.equal(activity?.toolActive, false);
        assert.notEqual(activity?.activeScope, "tool", "the tool is over");
      });
    });

    it("reports provider and streaming scopes", () => {
      withTempDir((dir) => {
        const { recorder, read, advance } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.turnStart(1);

        recorder.beforeProviderRequest();
        assert.equal(read()?.activeScope, "provider");

        recorder.afterProviderResponse();
        assert.equal(read()?.activeScope, "turn", "back to the turn between provider calls");

        // message_update is throttled, so the clock has to move for it to land.
        advance(5_000);
        recorder.messageUpdate("text");
        assert.equal(read()?.activeScope, "streaming");
      });
    });

    it("keeps the tool scope while a tool is running, even mid-stream", () => {
      withTempDir((dir) => {
        // A tool call is the more specific answer to "what is it doing", so
        // streaming must not overwrite it.
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.turnStart(1);
        recorder.toolExecutionStart("call-1", "bash");
        recorder.messageUpdate("text");

        assert.equal(read()?.activeScope, "tool");
      });
    });

    it("falls back to a coarser scope rather than nothing when a turn ends", () => {
      withTempDir((dir) => {
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        recorder.turnStart(1);
        recorder.toolExecutionStart("call-1", "bash");
        recorder.turnEnd(1);

        const activity = read();
        assert.equal(activity?.turnActive, false);
        assert.equal(activity?.toolActive, false);
        assert.equal(activity?.phase, "active", "the agent is still up between turns");
      });
    });
  });

  describe("durability", () => {
    it("advances the sequence on every write, so a reader can order them", () => {
      withTempDir((dir) => {
        const { recorder, read } = makeRecorder(dir);
        recorder.sessionStart();
        const first = read()?.sequence ?? -1;
        recorder.agentStart();
        const second = read()?.sequence ?? -1;
        recorder.turnStart(1);
        const third = read()?.sequence ?? -1;

        assert.ok(first < second && second < third, `expected increasing, got ${first},${second},${third}`);
      });
    });

    it("holds back a throttled write that arrives too soon", () => {
      withTempDir((dir) => {
        const { recorder, read, advance } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        const before = read()?.sequence;

        // message_update is throttled: a streaming agent emits these far faster
        // than any watcher needs them.
        advance(10);
        recorder.messageUpdate("text");
        assert.equal(read()?.sequence, before, "a burst must not become a write per token");

        recorder.sessionShutdown("reload"); // cancels the pending flush
      });
    });

    it("lets a throttled write through once the interval has passed", () => {
      withTempDir((dir) => {
        const { recorder, read, advance } = makeRecorder(dir);
        recorder.sessionStart();
        recorder.agentStart();
        const before = read()?.sequence ?? -1;

        advance(5_000);
        recorder.messageUpdate("text");
        assert.ok((read()?.sequence ?? -1) > before, "the update should have landed");
      });
    });

    it("gives up rather than letting a subagent die of its own telemetry", () => {
      withTempDir((dir) => {
        // A file where the directory should be, so every write throws.
        const blocker = join(dir, "blocked");
        writeFileSync(blocker, "not a directory", "utf8");
        const { recorder } = makeRecorder(dir, { file: join(blocker, "activity.json") });

        // Any of these could throw if failures were not absorbed.
        recorder.sessionStart();
        recorder.agentStart();
        recorder.turnStart(1);
        recorder.toolExecutionStart("call-1", "bash");
        recorder.agentEndWaiting();

        assert.equal(existsSync(join(blocker, "activity.json")), false);
      });
    });
  });
});
