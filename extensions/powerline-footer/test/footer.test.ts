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

test("context text turns peach at 256k and red at 512k regardless of model capacity", () => {
  const styled = new Theme(
    { muted: "#ffffff", text: "#ffffff", thinkingXhigh: "#ffffff" } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
  const cases = [
    [0, "166;227;161"],
    [255999, "166;227;161"],
    [256000, "250;179;135"],
    [511999, "250;179;135"],
    [512000, "243;139;168"],
    [900000, "243;139;168"],
    [null, "205;214;244"],
  ] as const;
  for (const contextWindow of [273000, 1000000, 0]) {
    for (const [used, rgb] of cases) {
      const line = new Footer(() => ({ ...snapshot, used, contextWindow }), styled).render(160)[0];
      const contextStyle = line.match(/((?:\x1b\[[\d;]*m)+) [▰▱░]{10} /)?.[1] ?? "";
      assert.ok(
        contextStyle.includes(`\x1b[38;2;${rgb}m`),
        `context color for ${used} tokens with capacity ${contextWindow}`,
      );
    }
  }
});

test("BG uses a dark olive segment with green ON text and soft peach OFF text", () => {
  const styled = new Theme(
    { muted: "#ffffff", text: "#ffffff", thinkingXhigh: "#ffffff" } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
  const on = new Footer(() => snapshot, styled).render(160)[0];
  const onStyle = on.match(/((?:\x1b\[[\d;]*m)+) BG ON /)?.[1] ?? "";
  assert.ok(onStyle.includes("\x1b[48;2;59;65;51m"), "BG ON uses a dark olive background");
  assert.ok(onStyle.includes("\x1b[38;2;166;227;161m"), "BG ON text remains green");
  const off = new Footer(() => ({ ...snapshot, statuses: new Map([[" bash-guard", "BG OFF"]]) }), styled).render(160)[0];
  const offStyle = off.match(/((?:\x1b\[[\d;]*m)+) BG OFF /)?.[1] ?? "";
  assert.ok(offStyle.includes("\x1b[48;2;59;65;51m"), "BG OFF keeps the same dark olive background");
  assert.ok(offStyle.includes("\x1b[38;2;250;179;135m"), "BG OFF uses soft peach warning text");
  const narrow = new Footer(() => ({ ...snapshot, statuses: new Map([[" bash-guard", "BG OFF"]]) }), styled).render(6)[0];
  assert.ok(narrow.includes("\x1b[38;2;250;179;135m"), "the compact warning also uses peach text");
});

test("BG's ordinary Powerline arrow carries its olive background into the next dark segment", () => {
  const styled = new Theme(
    { muted: "#ffffff", text: "#ffffff", thinkingXhigh: "#ffffff" } as ConstructorParameters<typeof Theme>[0],
    { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
  for (const guard of ["BG ON", "BG OFF"]) {
    const line = new Footer(() => ({ ...snapshot, statuses: new Map([[" bash-guard", guard]]) }), styled).render(160)[0];
    const afterGuard = line.slice(line.indexOf(` ${guard} `) + guard.length + 2);
    const arrowStyle = afterGuard.match(/^((?:\x1b\[[\d;]*m)+)/)?.[1] ?? "";
    assert.ok(arrowStyle.includes("\x1b[38;2;59;65;51m"), "the arrow uses the BG segment's own background colour");
    assert.ok(arrowStyle.includes("\x1b[48;2;49;50;68m"), "the arrow stays on the dark segment background");
  }
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
    () => ({ ...snapshot, statuses: new Map([[" bash-guard", "BG OFF"]]) }),
    theme,
  );
  assert.equal(plain(footer, 6), "BG OFF");
  assert.equal(plain(footer, 1), "B");
  assert.deepEqual(footer.render(0), [""]);
  for (const width of [1, 2, 5, 6, 7, 8, 9, 15, 30, 50, 79, 160]) {
    const lines = footer.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, `overflow at ${width}`);
    if (width >= 6) assert.ok(lines[0].includes("BG OFF"));
  }
});
