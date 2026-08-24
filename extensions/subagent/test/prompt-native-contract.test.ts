import { describe, expect, it } from "bun:test";
import { cap, HANDOFF } from "../cap.js";
import { getFinalText } from "../engine/index.js";
import subagentExtension from "../index.js";

describe("prompt-native contract", () => {
  it("caps raw previous output with a neutral marker at a valid UTF-8 boundary", () => {
    const capped = cap(`${"x".repeat(HANDOFF.bytes - 1)}🦖`, HANDOFF);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(HANDOFF.bytes);
    expect(capped).toEndWith(HANDOFF.marker);
    expect(capped).not.toContain("�");
  });

  it("returns every text segment from the final assistant message", () => {
    const output = getFinalText({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: " second" },
          ],
        } as never,
      ],
    });
    expect(output).toBe("first second");
  });

  it("registers no extension surfaces in a marked process", () => {
    const previous = process.env.PI_AGENT_LEAF;
    process.env.PI_AGENT_LEAF = "1";
    try {
      const forbiddenPiAccess = new Proxy(
        {},
        {
          get() {
            throw new Error("marked extension accessed the Pi registration API");
          },
        },
      );
      expect(() => subagentExtension(forbiddenPiAccess as never)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previous;
    }
  });

  it("rejects missing and empty prompt modes before any child run", async () => {
    const previousLeaf = process.env.PI_AGENT_LEAF;
    delete process.env.PI_AGENT_LEAF;
    try {
      let tool:
        | {
            execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
          }
        | undefined;
      subagentExtension({
        registerTool(value: typeof tool) {
          tool = value;
        },
        registerCommand() {},
        registerEntryRenderer() {},
        getThinkingLevel() {
          return "high";
        },
        events: { on() {}, emit() {} },
        on() {},
      } as never);
      if (!tool) throw new Error("subagent tool was not registered");
      const context = { cwd: process.cwd(), hasUI: false };
      await expect(tool.execute("", {}, undefined, undefined, context)).rejects.toThrow(
        "exactly one",
      );
      await expect(
        tool.execute("", { prompt: "   " }, undefined, undefined, context),
      ).rejects.toThrow("non-empty prompt");
      await expect(
        tool.execute("", { tasks: [{ prompt: "" }] }, undefined, undefined, context),
      ).rejects.toThrow("non-empty prompt");
      await expect(
        tool.execute(
          "",
          { prompt: "", tasks: [{ prompt: "valid" }] },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toThrow("exactly one");
    } finally {
      if (previousLeaf === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previousLeaf;
    }
  });
});
