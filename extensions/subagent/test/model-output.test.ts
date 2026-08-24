import { describe, expect, it } from "bun:test";
import { cap, MODEL_OUTPUT } from "../cap.js";
import { registerExtension } from "./support/extension-harness.js";
import type { ChildInvocation } from "../engine/spawn.js";
import { answering, failing, scriptedPool, type FakeChild } from "./support/fake-child.js";

function outputText(value: { content: Array<{ type: string; text: string }> }): string {
  return value.content[0]!.text;
}

function expectBound(output: string): void {
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MODEL_OUTPUT.bytes);
  expect(output.split("\n").length).toBeLessThanOrEqual(MODEL_OUTPUT.lines!);
  expect(output).toEndWith(MODEL_OUTPUT.marker);
  expect(output).not.toContain("�");
}

function toolHarness(child: () => FakeChild): {
  execute: (...args: any[]) => Promise<any>;
  started: ChildInvocation[];
} {
  const { pool, started } = scriptedPool(8, child);
  return { ...registerExtension(pool).tool, started };
}

describe("model-visible output policy", () => {
  it("bounds single final, error, and progress content without truncating raw details", async () => {
    const large = "🦖".repeat(MODEL_OUTPUT.bytes);
    const updates: string[] = [];
    const tool = toolHarness(() => answering(large));
    const context = { cwd: process.cwd(), hasUI: false };
    const completed = await tool.execute(
      "",
      { prompt: "large" },
      undefined,
      (update: any) => {
        updates.push(outputText(update));
      },
      context,
    );

    expectBound(outputText(completed));
    expectBound(updates[0]!);
    expect((completed.details.results[0].messages[0].content[0].text as string).length).toBe(
      large.length,
    );

    const failedTool = toolHarness(() => failing(large, large));
    const failed = await failedTool.execute(
      "",
      { prompt: "failure" },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(failed));
    expect((failed.details.results[0].errorMessage as string).length).toBe(large.length);
  });

  it("bounds chain failures and both per-child and aggregate parallel summaries", async () => {
    const large = "x".repeat(MODEL_OUTPUT.bytes);
    const context = { cwd: process.cwd(), hasUI: false };
    const chainTool = toolHarness(() => failing(large, large));
    const chain = await chainTool.execute(
      "",
      { chain: [{ prompt: "first", label: "first" }] },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(chain));
    expect(chain.details.results[0].errorMessage).toBe(large);

    const parallelTool = toolHarness(() => answering(large));
    const parallel = await parallelTool.execute(
      "",
      { tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: `prompt-${index}` })) },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(parallel));
    expect(outputText(parallel)).toContain(MODEL_OUTPUT.marker);
    expect(parallel.details.results).toHaveLength(8);
    expect(parallel.details.results[0].messages[0].content[0].text).toBe(large);
  });

  it("refuses more parallel items than the tool's ceiling before starting any child", async () => {
    const tool = toolHarness(() => answering("never reached"));

    await expect(
      tool.execute(
        "",
        { tasks: Array.from({ length: 9 }, (_, index) => ({ prompt: `prompt-${index}` })) },
        undefined,
        undefined,
        { cwd: process.cwd(), hasUI: false },
      ),
    ).rejects.toThrow("Too many parallel tasks");
    expect(tool.started).toHaveLength(0);
  });
});
