import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  describeResult,
  stripResultPreamble,
  usageSegments,
} from "../result.ts";
import type { SessionStats } from "../session.ts";

const NO_STATS: SessionStats = {
  model: null,
  toolCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextTokens: 0,
  cost: 0,
};

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({ ...NO_STATS, ...over });

/** The context segment is always last when present. */
function contextSegment(s: SessionStats) {
  const segs = usageSegments(s);
  return segs[segs.length - 1];
}

describe("result.ts", () => {
  describe("formatElapsed", () => {
    it("renders seconds under a minute", () => {
      assert.equal(formatElapsed(0), "0s");
      assert.equal(formatElapsed(59), "59s");
    });

    it("renders minutes and seconds past a minute", () => {
      assert.equal(formatElapsed(60), "1m 0s");
      assert.equal(formatElapsed(125), "2m 5s");
    });
  });

  describe("describeResult", () => {
    const base = { exitCode: 0, elapsed: 65, summary: "did the thing" };

    it("reports a completed run with its duration and a follow-up handle", () => {
      const text = describeResult(base, "worker-1");
      assert.match(text, /completed \(1m 5s\)/);
      assert.match(text, /did the thing/);
      assert.match(text, /send_message\(\{ to: "worker-1"/);
    });

    it("reports a non-zero exit with the code", () => {
      const text = describeResult({ ...base, exitCode: 3 }, "w");
      assert.match(text, /failed \(exit code 3\)/);
      assert.match(text, /did the thing/);
    });

    it("surfaces a provider error instead of treating the run as complete", () => {
      const text = describeResult({ ...base, errorMessage: "overloaded" }, "w");
      assert.match(text, /auto-retry exhausted/);
      assert.match(text, /Error: overloaded/);
      assert.match(text, /did not produce a result/);
      assert.doesNotMatch(text, /completed/);
    });

    it("prefers the provider error over a non-zero exit code", () => {
      const text = describeResult({ ...base, exitCode: 1, errorMessage: "rate limited" }, "w");
      assert.match(text, /Error: rate limited/);
      assert.doesNotMatch(text, /exit code 1/);
    });
  });

  describe("usageSegments", () => {
    it("returns nothing when there is no usage to report", () => {
      assert.deepEqual(usageSegments(NO_STATS), []);
    });

    it("compacts token counts and labels each direction", () => {
      const segs = usageSegments(stats({ inputTokens: 850, outputTokens: 3_200, cacheReadTokens: 45_000 }));
      assert.deepEqual(segs.map((s) => s.text), ["↑850", "↓3.2k", "R45k"]);
      assert.ok(segs.every((s) => s.severity === "normal"));
    });

    it("includes cost when there is one", () => {
      const segs = usageSegments(stats({ cost: 0.1234 }));
      assert.deepEqual(segs.map((s) => s.text), ["$0.123"]);
    });

    it("omits the context gauge when no context is recorded", () => {
      const segs = usageSegments(stats({ inputTokens: 10 }));
      assert.equal(segs.length, 1);
    });

    it("renders a percentage against a known model window", () => {
      const seg = contextSegment(stats({ model: "anthropic/claude-x", contextTokens: 36_000 }));
      assert.equal(seg.text, "18.0%/200k");
    });

    it("falls back to a raw count when the window is unknown", () => {
      const seg = contextSegment(stats({ model: "who/knows", contextTokens: 37_000 }));
      assert.equal(seg.text, "37k ctx");
      assert.equal(seg.severity, "normal", "an unknown window can't be a percentage of anything");
    });

    it("renders a million-token window in M", () => {
      const seg = contextSegment(stats({ model: "google/gemini-x", contextTokens: 500_000 }));
      assert.equal(seg.text, "50.0%/1.0M");
    });

    describe("severity thresholds", () => {
      const at = (pct: number) =>
        contextSegment(stats({ model: "anthropic/claude-x", contextTokens: Math.round(200_000 * pct / 100) })).severity;

      it("is normal at and below 70%", () => {
        assert.equal(at(50), "normal");
        assert.equal(at(70), "normal", "70 is not over 70");
      });

      it("warns above 70% and up to 90%", () => {
        assert.equal(at(70.5), "warning");
        assert.equal(at(90), "warning", "90 is not over 90");
      });

      it("is critical above 90%", () => {
        assert.equal(at(90.5), "critical");
        assert.equal(at(99), "critical");
      });
    });
  });

  describe("stripResultPreamble", () => {
    // The point of the pair living together: whatever describeResult writes,
    // this must take back off. Round-trip every variant rather than asserting
    // on the literal strings, so a reworded preamble fails here instead of
    // silently showing up twice in the notification.
    const cases = [
      ["completed", { exitCode: 0, elapsed: 65, summary: "the summary" }],
      ["non-zero exit", { exitCode: 3, elapsed: 65, summary: "the summary" }],
      ["provider error", { exitCode: 1, elapsed: 65, summary: "the summary", errorMessage: "boom" }],
    ] as const;

    for (const [label, run] of cases) {
      it(`round-trips a ${label} result`, () => {
        const name = "worker-1";
        const stripped = stripResultPreamble(describeResult(run, name), {
          name,
          elapsedText: formatElapsed(run.elapsed),
          exitCode: run.exitCode,
        });
        assert.doesNotMatch(stripped, /^Sub-agent /, `left a preamble: ${JSON.stringify(stripped)}`);
        assert.doesNotMatch(stripped, /Follow up with send_message/);
      });
    }

    it("survives a name containing regex metacharacters", () => {
      const name = "a.b(c)+d";
      const run = { exitCode: 1, elapsed: 30, summary: "s", errorMessage: "boom" };
      const stripped = stripResultPreamble(describeResult(run, name), {
        name,
        elapsedText: formatElapsed(run.elapsed),
        exitCode: run.exitCode,
      });
      assert.doesNotMatch(stripped, /^Sub-agent /);
    });

    it("leaves an unrelated message alone", () => {
      const text = "just a summary";
      assert.equal(
        stripResultPreamble(text, { name: "w", elapsedText: "1m 5s", exitCode: 0 }),
        text,
      );
    });
  });
});