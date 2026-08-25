import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentWidget, type WidgetRow } from "../widget.ts";
import type { StatusSnapshot } from "../status.ts";

/** A snapshot is a plain value here — the widget only ever reads it. */
function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    kind: "running",
    elapsedText: "1m",
    ...over,
  } as StatusSnapshot;
}

function row(over: Partial<WidgetRow> = {}): WidgetRow {
  return { name: "A", elapsedMs: 13_000, snapshot: snapshot(), ...over };
}

const SHOW = { showStatus: true };

describe("widget.ts", () => {
  describe("width contract", () => {
    it("keeps every rendered line within a very narrow width", () => {
      const lines = renderSubagentWidget(
        [
          row({ name: "A", elapsedMs: 13_000 }),
          row({ name: "B", elapsedMs: 21_000 }),
          row({ name: "C", elapsedMs: 27_000 }),
        ],
        16,
        SHOW,
      );

      assert.deepEqual(lines.map(visibleWidth), [16, 16, 16, 16, 16]);
    });

    it("never exceeds the width at ultra-narrow widths", () => {
      for (const width of [0, 1, 2]) {
        for (const line of renderSubagentWidget([row()], width, SHOW)) {
          assert.ok(
            visibleWidth(line) <= width,
            `expected <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
          );
        }
      }
    });

    it("truncates a right-hand label that alone is too wide", () => {
      const wide = snapshot({ kind: "waiting", waitingDurationText: "999 msgs (999.9KB) long" });
      const lines = renderSubagentWidget([row({ snapshot: wide })], 16, SHOW);
      for (const line of lines) assert.equal(visibleWidth(line), 16);
    });
  });

  describe("row content", () => {
    it("renders elapsed time as MM:SS from the elapsed it is given", () => {
      const [, body] = renderSubagentWidget([row({ elapsedMs: 65_000 })], 60, SHOW);
      assert.match(body, /01:05/);
    });

    it("clamps a backwards clock to zero rather than rendering -1:-1", () => {
      const [, body] = renderSubagentWidget([row({ elapsedMs: -5_000 })], 60, SHOW);
      assert.match(body, /00:00/);
      assert.doesNotMatch(body, /-/);
    });

    it("shows the agent role in parentheses when there is one", () => {
      const [, body] = renderSubagentWidget([row({ name: "scout-1", agent: "scout" })], 60, SHOW);
      assert.match(body, /scout-1 \(scout\)/);
    });

    it("omits the parenthetical when there is no role", () => {
      const [, body] = renderSubagentWidget([row({ name: "solo" })], 60, SHOW);
      assert.doesNotMatch(body, /solo \(/);
    });

    it("counts the running subagents in the title bar", () => {
      const [top] = renderSubagentWidget([row(), row()], 60, SHOW);
      assert.match(top, /Subagents/);
      assert.match(top, /2 running/);
    });
  });

  describe("showStatus", () => {
    it("renders the live status label when status is enabled", () => {
      const active = snapshot({ kind: "active", activityLabel: "bash", activeScope: "tool" });
      const [, body] = renderSubagentWidget([row({ snapshot: active })], 60, SHOW);
      assert.match(body, /active · bash/);
    });

    it("falls back to a fixed label when status is disabled", () => {
      const active = snapshot({ kind: "active", activityLabel: "bash", activeScope: "tool" });
      const [, body] = renderSubagentWidget([row({ snapshot: active })], 60, { showStatus: false });
      assert.doesNotMatch(body, /bash/);
      assert.match(body, /starting…/);
    });
  });

  describe("status labels", () => {
    const cases: Array<[string, Partial<StatusSnapshot>, RegExp]> = [
      ["starting", { kind: "starting" }, /starting…/],
      ["running", { kind: "running", elapsedText: "2m" }, /running 2m/],
      ["active with a tool", { kind: "active", activityLabel: "grep", activeScope: "tool" }, /active · grep/],
      ["waiting", { kind: "waiting", waitingDurationText: "30s" }, /waiting 30s/],
      ["stalled", { kind: "stalled", statusLabel: "no output" }, /stalled · no output/],
    ];

    for (const [label, over, expected] of cases) {
      it(`labels ${label}`, () => {
        const [, body] = renderSubagentWidget([row({ snapshot: snapshot(over) })], 80, SHOW);
        assert.match(body, expected);
      });
    }
  });
});
