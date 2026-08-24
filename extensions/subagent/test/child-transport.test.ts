import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { getFinalText } from "../engine/index.js";
import { createChildPool } from "../engine/index.js";

describe("child prompt transport", () => {
  it("sends the exact prompt over stdin, closes it, and reads the child's NDJSON back", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/stdin-echo.mjs", import.meta.url));
    const originalScript = process.argv[1];
    const previousLeaf = process.env.PI_AGENT_LEAF;
    delete process.env.PI_AGENT_LEAF;
    process.argv[1] = fixture;
    try {
      const prompt = "Keep this exact:\nTask: not added by the engine.";
      // The fixture reads stdin to EOF, so this only settles if the engine closes stdin.
      const result = await createChildPool(1).run({ prompt });

      expect(result.stopReason).toBe("completed");
      expect(getFinalText(result)).toBe(prompt);
    } finally {
      process.argv[1] = originalScript!;
      if (previousLeaf === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previousLeaf;
    }
  });
});
