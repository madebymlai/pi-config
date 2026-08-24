import { describe, expect, it } from "bun:test";
import { registerExtension } from "./support/extension-harness.js";
import { answering, scriptedPool, waitFor, type FakeChild } from "./support/fake-child.js";

describe("subagent TUI working messages", () => {
  for (const [name, params] of [
    ["single", { prompt: "one" }],
    ["chain", { chain: [{ prompt: "one" }] }],
    ["parallel", { tasks: [{ prompt: "one" }] }],
  ] as const) {
    it(`clears the ${name} working message when aborting while queued`, async () => {
      const finishers: Array<(child: FakeChild) => void> = [];
      const { pool, started } = scriptedPool(
        1,
        () => new Promise<FakeChild>((resolve) => finishers.push(resolve)),
      );
      // Occupy the pool's only permit, so the tool call below has to queue for it.
      void pool.run({ prompt: "occupies the only permit" });
      await waitFor(() => started.length === 1);

      const { tool } = registerExtension(pool);
      const controller = new AbortController();
      const messages: Array<string | undefined> = [];
      const context = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          setWorkingMessage(message?: string) {
            messages.push(message);
          },
        },
      };

      const execution = tool.execute("", params, controller.signal, undefined, context);
      await Promise.resolve();
      controller.abort();
      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      expect(messages[0]).toEqual(expect.any(String));
      expect(messages.at(-1)).toBeUndefined();
      expect(started).toHaveLength(1);
      finishers[0]!(answering("done"));
    });
  }
});
