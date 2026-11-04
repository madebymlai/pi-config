import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Footer, type FooterSnapshot } from "../footer.ts";

const theme = { style: (text: string) => text };
const snapshot: FooterSnapshot = {
  model: "claude-sonnet-4-5",
  thinking: "high",
  input: 12500,
  output: 3400,
  used: 123000,
  contextWindow: 273000,
  project: "pi-config",
  branch: "main",
  statuses: new Map([[" bash-guard", "BG ON"]]),
};
const plain = (footer: Footer, width: number) =>
  stripVTControlCharacters(footer.render(width)[0]).trimEnd();

test("one powerline row includes model, effort, both cumulative counts and used context, dropping project at 79", () => {
  const footer = new Footer(() => snapshot, theme);
  assert.equal(
    plain(footer, 79),
    " claude-sonnet-4-5 high  ↑13k ↓3.4k  ▰▰▰▰▱▱▱▱▱▱ 123k  BG ON ",
  );
  assert.equal(footer.render(79).length, 1);
});

test("real Theme emits Mocha colors, resets transitions and supports 256-color terminals", () => {
  for (const mode of ["truecolor", "256color"] as const) {
    const styled = new Theme(
      {
        muted: "#ffffff",
        text: "#ffffff",
        thinkingXhigh: "#ffffff",
      } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
      mode,
    );
    const footer = new Footer(() => snapshot, styled);
    const line = footer.render(79)[0];
    assert.equal(visibleWidth(line), 79);
    assert.ok(line.endsWith("\u001b[0m"));
    if (mode === "truecolor") {
      assert.ok(line.includes("\u001b[48;2;203;166;247m"));
      assert.ok(line.includes("\u001b[38;2;166;227;161m"));
    } else {
      assert.ok(line.includes("\u001b[48;5;"));
      assert.ok(!line.includes(";2;203;166;247m"));
    }
    assert.equal(
      plain(footer, 79),
      " claude-sonnet-4-5 high  ↑13k ↓3.4k  ▰▰▰▰▱▱▱▱▱▱ 123k  BG ON ",
    );
  }
});

test("BG ON blends into the dark segments while BG OFF keeps a red warning background", () => {
  const styled = new Theme(
    { muted: "#ffffff", text: "#ffffff", thinkingXhigh: "#ffffff" } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
  const on = new Footer(() => snapshot, styled).render(160)[0];
  const onStyle = on.match(/((?:\x1b\[[\d;]*m)+) BG ON /)?.[1] ?? "";
  assert.ok(onStyle.includes("\x1b[48;2;49;50;68m"), "BG ON uses the same dark Mocha surface as the token segment");
  assert.ok(onStyle.includes("\x1b[38;2;166;227;161m"), "BG ON text remains green");
  const off = new Footer(() => ({ ...snapshot, statuses: new Map([[" bash-guard", "⚠ BG OFF"]]) }), styled).render(160)[0];
  const offStyle = off.match(/((?:\x1b\[[\d;]*m)+) ⚠ BG OFF /)?.[1] ?? "";
  assert.ok(offStyle.includes("\x1b[48;2;243;139;168m"), "BG OFF keeps its solid red warning");
  assert.ok(offStyle.includes("\x1b[38;2;30;30;46m"), "BG OFF keeps contrasting dark text");
});

test("untrusted labels cannot inject terminal controls or additional rows", () => {
  const footer = new Footer(
    () => ({
      ...snapshot,
      model: "模型\u001b[31m\nX\u001b[0m\u0007",
      project: "项目\rZ",
      branch: "main\u001b]0;evil\u0007",
      statuses: new Map([
        [" bash-guard", "\u001b[32mBG ON\u001b[0m"],
        ["reserved", " \n "],
        ["other", "ready\t✓"],
      ]),
    }),
    theme,
  );
  const line = footer.render(160)[0];
  assert.ok(line.includes("模型 X high"));
  assert.ok(line.includes("项目 Z  main"));
  assert.ok(line.includes("ready ✓"));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line));
  for (const width of [0, 1, 2, 8, 25, 79, 160])
    assert.ok(visibleWidth(footer.render(width)[0]) <= width);
});

test("unknown context is neutral and explicit; over-capacity clamps only bar fill", () => {
  const unknown = new Footer(() => ({ ...snapshot, used: null }), theme);
  assert.ok(plain(unknown, 79).includes("░░░░░░░░░░ ?"));
  assert.ok(!plain(unknown, 79).includes(" 0 "));
  const overflow = new Footer(() => ({ ...snapshot, used: 300000 }), theme);
  assert.ok(plain(overflow, 79).includes("▰▰▰▰▰▰▰▰▰▰ 300k"));
});

test("BG OFF survives narrow widths before model, tokens and powerline decoration", () => {
  const footer = new Footer(
    () => ({ ...snapshot, statuses: new Map([[" bash-guard", "⚠ BG OFF"]]) }),
    theme,
  );
  assert.equal(plain(footer, 8), "⚠ BG OFF");
  assert.equal(plain(footer, 1), "⚠");
  assert.deepEqual(footer.render(0), [""]);
  for (const width of [1, 2, 7, 8, 9, 15, 30, 50, 79, 160]) {
    const lines = footer.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, `overflow at ${width}`);
    if (width >= 8) assert.ok(lines[0].includes("⚠ BG OFF"));
  }
});
