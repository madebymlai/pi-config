import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readSubagentResultDetails,
  renderSubagentResult,
  type SubagentResultDetails,
} from "../render/subagent-result.ts";
import { UNPAINTED as theme, type RenderContext } from "../render/theme.ts";
import type { SessionStats } from "../observe/transcript.ts";

const context = (over: Partial<RenderContext> = {}): RenderContext => ({
  theme, expandHint: () => "ctrl+o to expand", expanded: false, width: 100, ...over,
});

const STATS: SessionStats = {
  model: "claude-opus-5",
  toolCount: 7,
  inputTokens: 1_234,
  outputTokens: 567,
  cacheReadTokens: 890,
  cacheWriteTokens: 12,
  contextTokens: 90_000,
  cost: 0.34,
};

const details = (over: Partial<SubagentResultDetails> = {}): SubagentResultDetails => ({
  name: "Worker", agent: "worker", exitCode: 0, errorMessage: "",
  elapsed: 65, stats: STATS, sessionFile: "/tmp/s.jsonl", ...over,
});

describe("render/subagent-result.ts", () => {
  describe("reading details off a message", () => {
    it("declines a message that is not ours", () => {
      assert.equal(readSubagentResultDetails(null), null);
      assert.equal(readSubagentResultDetails("x"), null);
    });

    it("treats an untimed run as unknown rather than as instant", () => {
      assert.equal(readSubagentResultDetails({ name: "W" })?.elapsed, null);
    });

    it("defaults a missing exit code to success", () => {
      assert.equal(readSubagentResultDetails({ name: "W" })?.exitCode, 0);
    });
  });

  describe("did it work", () => {
    it("reports success with what it cost instead of the word success", () => {
      const body = renderSubagentResult(details(), "", context()).join("\n");
      assert.match(body, /✓/);
      assert.match(body, /7 tools/);
      assert.doesNotMatch(body, /failed/);
    });

    it("names the exit code when the process failed", () => {
      const body = renderSubagentResult(details({ exitCode: 2 }), "", context()).join("\n");
      assert.match(body, /✗/);
      assert.match(body, /failed \(exit 2\)/);
    });

    it("distinguishes a provider error from a bad exit code", () => {
      // A clean exit with an error message is still a failure, and the reader
      // needs a different response than "exit 1" would call for.
      const body = renderSubagentResult(
        details({ exitCode: 0, errorMessage: "provider exploded" }), "", context(),
      ).join("\n");
      assert.match(body, /✗/);
      assert.match(body, /failed \(provider\/agent error\)/);
      assert.doesNotMatch(body, /exit 0/);
    });

    it("says the duration is unknown rather than inventing one", () => {
      const body = renderSubagentResult(details({ elapsed: null }), "", context()).join("\n");
      assert.match(body, /\?/);
    });
  });

  describe("what it cost", () => {
    it("omits the usage line entirely when there are no stats", () => {
      const body = renderSubagentResult(details({ stats: null }), "", context()).join("\n");
      assert.doesNotMatch(body, /\$/);
      assert.match(body, /1m 5s/, "the elapsed time still shows");
    });

    it("shows the model when the stats name one", () => {
      assert.match(renderSubagentResult(details(), "", context()).join("\n"), /claude-opus-5/);
    });

    it("reports tokens and cost on the usage line", () => {
      const body = renderSubagentResult(details(), "", context()).join("\n");
      assert.match(body, /↑1\.2k/, "input tokens");
      assert.match(body, /↓567/, "output tokens");
      assert.match(body, /\$0\.340/, "cost");
      // The gauge shows a percentage because the model's window is known;
      // an unrecognised model falls back to a bare token count.
      assert.match(body, /45\.0%\/200k/, "context gauge");
    });
  });

  describe("what it said", () => {
    const long = Array.from({ length: 9 }, (_, i) => `summary line ${i}`).join("\n");

    it("caps the preview and says how much it held back", () => {
      const body = renderSubagentResult(details(), long, context()).join("\n");
      assert.match(body, /summary line 4/);
      assert.doesNotMatch(body, /summary line 5/);
      assert.match(body, /… 4 more lines/);
    });

    it("shows everything when expanded, with no expand hint", () => {
      const body = renderSubagentResult(details(), long, context({ expanded: true })).join("\n");
      assert.match(body, /summary line 8/);
      assert.doesNotMatch(body, /more lines/);
      assert.doesNotMatch(body, /to expand/);
    });

    it("truncates a summary line that is wider than the box", () => {
      // Distinct from the 5-line collapse cap: this is per-line width.
      const wide = "z".repeat(400);
      const body = renderSubagentResult(details(), wide, context({ width: 40, expanded: true })).join("\n");
      assert.ok(!body.includes("z".repeat(60)), "a long line should not run past the box");
      assert.match(body, /z{20,}/, "but it should still show what fits");
    });

    it("omits the follow-up section entirely when there is nothing to follow up to", () => {
      // The gate reads the raw name, so a nameless payload gets no hint
      // addressed to a subagent nobody can reach.
      const body = renderSubagentResult(
        { name: undefined, agent: undefined, exitCode: 0, errorMessage: "", elapsed: 1, stats: null,
          sessionFile: undefined },
        "done",
        context({ expanded: true }),
      ).join("\n");
      assert.doesNotMatch(body, /Follow up/);
      assert.doesNotMatch(body, /Session file/);
    });

    it("gives the reader the call that continues the conversation", () => {
      const body = renderSubagentResult(details(), long, context({ expanded: true })).join("\n");
      assert.match(body, /send_message\(\{ to: "Worker"/);
      assert.match(body, /Session file: \/tmp\/s\.jsonl/);
    });

    it("does not resolve the expand hint when expanded", () => {
      let resolved = 0;
      renderSubagentResult(details(), long, context({
        expanded: true, expandHint: () => { resolved += 1; return "x"; },
      }));
      assert.equal(resolved, 0);
    });
  });
});
