import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
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

test("click opens the visible row, not the header or scroll indicator", () => {
  const { list, opened } = setup();
  list.render(80);
  list.handleMouse(mouse(0));
  list.handleMouse(mouse(2, "press"));
  list.handleMouse(mouse(2));
  list.handleMouse(mouse(4));
  assert.deepEqual(opened, ["b"]);
});

test("paging and mouse scrolling reach many agents within a bounded viewport", () => {
  const { list, opened } = setup(Array.from({ length: 100 }, (_, i) => row(String(i))));
  list.setHeight(9);
  list.handleInput("\x1b[6~");
  list.handleInput("\r");
  assert.deepEqual(opened, ["5"]);
  assert.ok(list.render(40).length <= 9);
  list.handleInput("\x1b[F");
  list.handleInput("\r");
  assert.deepEqual(opened, ["5", "99"]);
  list.handleMouse({ ...mouse(2, "wheel"), wheelDelta: -1 });
  list.handleInput("\r");
  assert.equal(opened.at(-1), "98");
});

test("names take priority, widths include Unicode, disabled statuses stay hidden", () => {
  const { list } = setup([row("a", "探索👩‍💻é-name")]);
  for (const width of [0, 1, 2, 3, 8, 16, 40, 100]) {
    for (const line of list.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.match(list.render(100).join("\n"), /探索👩‍💻é-name \(scout\).*1m.*active.*reading/);
  list.update({ rows: [row("a", "recognizable-name")], showStatus: false });
  assert.match(list.render(24)[1], /recognizable-name/);
  assert.doesNotMatch(list.render(100).join("\n"), /active|reading|starting/);
});

test("back shortcuts and failed callbacks never terminate the component", async () => {
  let backs = 0;
  const list = new SurfaceList({ onSelect: async () => { throw new Error("cannot open"); }, onBack: () => { backs++; } });
  list.update({ rows: [row("a")], showStatus: true });
  for (const key of ["\x1b[D", "\x1b", "\x03"]) list.handleInput(key);
  assert.equal(backs, 3, "left, Escape and Ctrl+C return focus to main");
  list.handleInput("\x1a");
  list.handleInput("\x1b\x01");
  assert.equal(backs, 3, "neither the retired Ctrl+Z binding nor open-list shortcut should leave the list");
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
