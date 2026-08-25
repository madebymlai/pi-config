import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  readSubagentStatusDetails,
  renderSubagentStatus,
} from "../render/subagent-status.ts";
import type { RenderContext } from "../render/theme.ts";

/** Returns its input unchanged, so assertions read as plain strings. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function context(over: Partial<RenderContext> = {}): RenderContext {
  return { theme, expandHint: () => "ctrl+o to expand", expanded: false, width: 60, ...over };
}

const LINES = [
  "Worker running 5m, active (bash 2m).",
  "Scout running 3m, waiting 1m.",
];

describe("render/subagent-status.ts", () => {
  describe("reading details off a message", () => {
    it("declines a message that is not ours", () => {
      assert.equal(readSubagentStatusDetails(null), null);
      assert.equal(readSubagentStatusDetails("nope"), null);
      assert.equal(readSubagentStatusDetails({}), null);
    });

    it("declines when there is nothing to say", () => {
      assert.equal(readSubagentStatusDetails({ lines: [], overflow: 0 }), null);
    });

    it("accepts an overflow with no visible lines", () => {
      // A limit of zero caps everything away but still has news.
      assert.deepEqual(readSubagentStatusDetails({ lines: [], overflow: 4 }), {
        lines: [],
        overflow: 4,
      });
    });

    it("tolerates missing fields rather than trusting the payload", () => {
      assert.deepEqual(readSubagentStatusDetails({ lines: LINES }), { lines: LINES, overflow: 0 });
    });
  });

  describe("rendering", () => {
    it("titles the box and lists the lines", () => {
      const body = renderSubagentStatus({ lines: LINES, overflow: 0 }, context()).join("\n");
      assert.match(body, /Subagent status/);
      for (const line of LINES) assert.match(body, new RegExp(line.split(" ")[0]));
    });

    it("says how many it left out", () => {
      const body = renderSubagentStatus({ lines: LINES, overflow: 3 }, context()).join("\n");
      assert.match(body, /\+3 more running\./);
    });

    it("offers the expand hint only when collapsed", () => {
      // This branch was unreachable before the renderer moved out of index.ts:
      // it called pi's keyHint() directly, which throws on uninitialised global
      // theme state, so the only test that existed always passed expanded: true.
      const collapsed = renderSubagentStatus({ lines: LINES, overflow: 0 }, context()).join("\n");
      assert.match(collapsed, /ctrl\+o to expand/);

      const expanded = renderSubagentStatus(
        { lines: LINES, overflow: 0 },
        context({ expanded: true }),
      ).join("\n");
      assert.doesNotMatch(expanded, /to expand/);
    });

    it("does not resolve the hint at all when expanded", () => {
      // Resolving eagerly would make an expanded render depend on a live pi.
      let resolved = 0;
      renderSubagentStatus(
        { lines: LINES, overflow: 0 },
        context({ expanded: true, expandHint: () => { resolved += 1; return "x"; } }),
      );
      assert.equal(resolved, 0);
    });

    it("keeps every line inside the given width", () => {
      // Measured by visible width, not string length: a truncated line carries
      // ANSI sequences that .length counts and a terminal does not.
      for (const width of [12, 20, 60]) {
        const lines = renderSubagentStatus(
          { lines: ["A".repeat(200) + " running 5m."], overflow: 2 },
          context({ width }),
        );
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `expected <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
          );
        }
      }
    });

    it("opens with a blank line so it separates from what came before", () => {
      assert.equal(renderSubagentStatus({ lines: LINES, overflow: 0 }, context())[0], "");
    });
  });
});
