import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SurfaceList, parseSurfaceListSnapshot, type SurfaceListRow } from "../render/surface-list.ts";
import type { StatusSnapshot } from "../observe/status-snapshot.ts";

function row(surface: string, name = surface): SurfaceListRow {
  return { surface, name, agent: "scout", elapsedMs: 65000,
    snapshot: { kind: "active", activityLabel: "reading" } as StatusSnapshot };
}
function setup(rows = [row("a"), row("b"), row("c")]) {
  const opened: string[] = [];
  const list = new SurfaceList({ onSelect: (id) => { opened.push(id); }, onBack: () => {} });
  list.update({ rows, showStatus: true });
  return { list, opened };
}

function mouse(y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
  return { type, button: "left", x: 3, y, screenX: 3, screenY: y, width: 80, height: 10, shift: false, alt: false, ctrl: false };
}

test("aligns agent, activity and elapsed columns with shortcuts in a separate footer", () => {
  const rows = [row("a", "Alpha"), {
    ...row("b", "Longer agent"), elapsedMs: 7380000,
    snapshot: { kind: "active", activityLabel: "bash" } as StatusSnapshot,
  }];
  const { list } = setup(rows);
  list.setHeight(14);
  const lines = list.render(90).map(stripTerminalSequences);
  assert.equal(lines[0], " ".repeat(81) + "2 running");
  assert.doesNotMatch(lines.join("\n"), /Subagents|Agents list/);
  assert.match(lines[2], /AGENT\s+ACTIVITY\s+ELAPSED/);
  assert.match(lines[3], /Alpha \(scout\)\s+reading\s+1m$/);
  assert.match(lines[4], /Longer agent \(scout\)\s+bash\s+2h 3m$/);
  assert.equal(lines[3].indexOf("reading"), lines[4].indexOf("bash"));
  assert.equal(visibleWidth(lines[3]), visibleWidth(lines[4]), "elapsed values share a right edge");
  assert.doesNotMatch(lines.join("\n"), /[·•]/);
  assert.match(lines.at(-2)!, /^─+$/);
  assert.match(lines.at(-1)!, /Enter.*Esc.*Main/);
  assert.doesNotMatch(lines.join("\n"), /From a session|Ctrl\+Alt|empty prompt/);
  assert.doesNotMatch(lines.slice(0, -2).join("\n"), /Enter/);
});

test("click opens the visible row, not the header or scroll indicator", () => {
  const { list, opened } = setup();
  list.render(80);
  list.handleMouse(mouse(0));
  list.handleMouse(mouse(2)); // column headings
  list.handleMouse(mouse(4, "press"));
  list.handleMouse(mouse(4));
  list.handleMouse(mouse(6)); // blank area below the three agents
  assert.deepEqual(opened, ["b"]);
});

test("paging and mouse scrolling reach many agents within a bounded viewport", () => {
  const { list, opened } = setup(Array.from({ length: 100 }, (_, i) => row(String(i))));
  list.setHeight(11); // 3 header lines, 5 agents, scroll indicator, 2 footer lines
  list.handleInput("\x1b[6~");
  list.handleInput("\r");
  assert.deepEqual(opened, ["5"]);
  assert.equal(list.render(40).length, 11);
  list.handleInput("\x1b[F");
  list.handleInput("\r");
  assert.deepEqual(opened, ["5", "99"]);
  list.handleMouse({ ...mouse(4, "wheel"), wheelDelta: -1 });
  list.handleInput("\r");
  assert.equal(opened.at(-1), "98");
});

test("names take priority, widths include Unicode, disabled statuses stay hidden", () => {
  const { list } = setup([row("a", "探索👩‍💻é-name")]);
  for (const width of [0, 1, 2, 3, 8, 16, 40, 100]) {
    for (const line of list.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.match(stripTerminalSequences(list.render(100).join("\n")), /探索👩‍💻é-name \(scout\).*reading.*1m/);
  list.update({ rows: [row("a", "recognizable-name")], showStatus: false });
  assert.match(list.render(24)[3], /recognizable-name/);
  assert.doesNotMatch(list.render(100).join("\n"), /active|reading|starting/);
});

test("keeps selection and usable rows when resized to short or narrow panes", () => {
  const { list, opened } = setup();
  list.handleInput("\x1b[B");
  for (const height of [1, 2, 3, 4, 8, 10, 30]) {
    list.setHeight(height);
    for (const width of [0, 1, 12, 36, 80]) {
      const lines = list.render(width);
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    list.handleInput("\r");
  }
  assert.deepEqual(opened, Array(7).fill("b"), "layout changes must not move the selected agent");
});

test("back shortcuts and failed callbacks never terminate the component", async () => {
  let backs = 0;
  const list = new SurfaceList({ onSelect: async () => { throw new Error("cannot open"); }, onBack: () => { backs++; } });
  list.update({ rows: [row("a")], showStatus: true });
  for (let repeat = 0; repeat < 10; repeat++) list.handleInput("\x1b[D");
  for (const key of ["\x03", "\x1a", "\x1b\x01"]) list.handleInput(key);
  assert.equal(backs, 0, "left repeats and other shortcuts must not bounce focus back to main");
  list.handleInput("\x1b");
  assert.equal(backs, 1, "only Escape returns focus to main");
  assert.doesNotMatch(stripTerminalSequences(list.render(100).join("\n")), /←\/?Esc|←\s+Main/);
  assert.doesNotMatch(list.render(100).join("\n"), /Ctrl\+Z/);
  list.handleInput("\r");
  await Promise.resolve();
  assert.match(list.render(80).join("\n"), /cannot open/);
});

test("snapshot boundary rejects transitional malformed data", () => {
  for (const text of ["", "{", "[]", '{"rows":[{}],"showStatus":true}', JSON.stringify({ rows: [row("a"), row("a")], showStatus: true })]) {
    assert.equal(parseSurfaceListSnapshot(text), undefined);
  }
  assert.deepEqual(parseSurfaceListSnapshot(JSON.stringify({ rows: [row("a")], showStatus: false }))?.rows.map((r) => r.surface), ["a"]);
});

test("selection follows surface identity across snapshots and chooses next neighbor on removal", () => {
  const { list, opened } = setup();
  list.handleInput("\x1b[B");
  list.update({ rows: [row("c"), row("b", "renamed"), row("a")], showStatus: true });
  list.handleInput("\r");
  assert.deepEqual(opened, ["b"]);
  assert.match(list.render(80).join("\n"), /renamed/);
  list.update({ rows: [row("c"), row("a")], showStatus: true });
  list.handleInput("\r");
  assert.deepEqual(opened, ["b", "a"]);
});
