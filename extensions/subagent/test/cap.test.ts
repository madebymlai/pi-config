import { describe, expect, it } from "bun:test";
import { cap, BTW, HANDOFF, MODEL_OUTPUT, PARALLEL_CHILD, type Destination } from "../cap.js";

const DESTINATIONS: Array<[string, Destination]> = [
  ["model output", MODEL_OUTPUT],
  ["parallel child", PARALLEL_CHILD],
  ["handoff", HANDOFF],
  ["side question", BTW],
];

function within(text: string, to: Destination): void {
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(to.bytes);
  if (to.lines !== undefined) expect(text.split("\n").length).toBeLessThanOrEqual(to.lines);
  expect(text).not.toContain("�");
}

describe("bounding text", () => {
  it("returns text unchanged when it fits, so a comparison is the truncation signal", () => {
    for (const [name, to] of DESTINATIONS) {
      const fits = `${name}: comfortably inside every allowance`;
      expect(cap(fits, to)).toBe(fits);
      expect(cap("", to)).toBe("");
    }
  });

  it("bounds bytes and lines inclusive of the marker, without splitting a code point", () => {
    for (const [, to] of DESTINATIONS) {
      const oversized = `${"line\n".repeat(to.lines ?? 700)}${"\u{1F996}".repeat(to.bytes)}`;
      const bounded = cap(oversized, to);
      within(bounded, to);
      expect(bounded).not.toBe(oversized);
      expect(bounded).toEndWith(to.marker);
    }
  });

  it("bounds bytes only where the destination has no line ceiling", () => {
    const many = Array.from({ length: 5_000 }, (_, index) => `l${index}`).join("\n");
    expect(HANDOFF.lines).toBeUndefined();
    expect(cap(many, HANDOFF)).toBe(many);
    expect(cap(many, MODEL_OUTPUT).split("\n").length).toBeLessThanOrEqual(MODEL_OUTPUT.lines!);
  });

  it("trims lines before bytes, so a line-only overflow keeps whole lines", () => {
    const lineOnly = Array.from({ length: 900 }, (_, index) => `l${index}`).join("\n");
    expect(Buffer.byteLength(lineOnly, "utf8")).toBeLessThan(MODEL_OUTPUT.bytes);
    const bounded = cap(lineOnly, MODEL_OUTPUT);
    const body = bounded.slice(0, -MODEL_OUTPUT.marker.length);
    expect(lineOnly.startsWith(body)).toBe(true);
    expect(body.endsWith("l598")).toBe(true);
    // The allowance is filled exactly, not merely respected.
    expect(bounded.split("\n")).toHaveLength(MODEL_OUTPUT.lines!);
    expect(cap(lineOnly, BTW).split("\n")).toHaveLength(BTW.lines!);
  });
});
