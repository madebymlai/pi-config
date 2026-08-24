import { describe, expect, it } from "bun:test";
import { deriveBtwTitle } from "../by-the-way.js";
import { BTW } from "../cap.js";
import { registerExtension } from "./support/extension-harness.js";
import { answering, failing, scriptedPool, waitFor, type FakeChild } from "./support/fake-child.js";
import type { ChildInvocation } from "../engine/spawn.js";

type Respond = (invocation: ChildInvocation, index: number) => FakeChild | Promise<FakeChild>;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(respond: Respond, limit = 4) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const { pool, started } = scriptedPool(limit, respond);
  const { btw: command, entries, fire } = registerExtension(pool);
  const context = {
    cwd: "/fixture",
    mode: "tui",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-terra" },
    ui: {
      input: async () => undefined,
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };
  return { command, context, entries, fire, notifications, started };
}

describe("/btw helpers", () => {
  it("derives a normalized, Unicode-safe title", () => {
    expect(deriveBtwTitle("\n  What\t is this?  \nsecond line")).toBe("What is this?");
    expect(deriveBtwTitle("  \n\t ")).toBe("by the way");
    expect(deriveBtwTitle("🦖".repeat(61))).toBe(`${"🦖".repeat(59)}…`);
  });
});

describe("/btw command", () => {
  it("registers the TUI-only command and preserves the leaf registration guard", async () => {
    const previousLeaf = process.env.PI_AGENT_LEAF;
    delete process.env.PI_AGENT_LEAF;
    try {
      const harness = createHarness(() => answering("answer"));
      expect(harness.command.description).toContain("one-off side question");
      harness.context.mode = "rpc";
      await harness.command.handler("question", harness.context);
      expect(harness.notifications).toEqual([
        { message: "/btw is available only in the TUI.", type: "warning" },
      ]);
      expect(harness.started).toHaveLength(0);
    } finally {
      if (previousLeaf === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previousLeaf;
    }
  });

  it("prompts for missing input and ignores cancelled or blank questions", async () => {
    const harness = createHarness(() => answering("answer"));
    await harness.command.handler("", harness.context);
    harness.context.ui.input = async () => "   ";
    await harness.command.handler("", harness.context);
    harness.context.ui.input = async () => "  entered question  ";
    await harness.command.handler("", harness.context);
    await waitFor(() => harness.started.length === 1);
    expect(harness.started.map((invocation) => invocation.prompt)).toEqual(["entered question"]);
  });

  it("starts an exact prompt-native run and returns before it settles", async () => {
    const finishers: Array<(child: FakeChild) => void> = [];
    const harness = createHarness(
      () => new Promise<FakeChild>((resolve) => finishers.push(resolve)),
    );
    await harness.command.handler("  Keep this exact.  ", harness.context);
    await waitFor(() => harness.started.length === 1);

    const invocation = harness.started[0]!;
    expect(invocation.prompt).toBe("Keep this exact.");
    expect(invocation.cwd).toBe("/fixture");
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--model", "openai-codex/gpt-5.6-terra", "--thinking", "high"]),
    );
    expect(invocation.signal?.aborted).toBe(false);
    expect(harness.entries).toHaveLength(0);

    finishers[0]!(answering("settled answer"));
    await waitFor(() => harness.entries.length === 1);
    expect(harness.entries).toEqual([
      expect.objectContaining({
        type: "btw-result",
        data: expect.objectContaining({
          id: "btw-1",
          status: "completed",
          prompt: "Keep this exact.",
          answer: "settled answer",
        }),
      }),
    ]);
    expect(harness.notifications).toEqual([
      { message: "By the way complete: Keep this exact.", type: "info" },
    ]);
  });

  it("settles a failing child and a child that never started, once each", async () => {
    const harness = createHarness((_invocation, index) => {
      if (index === 0) return failing("child failed", "provider output");
      throw new Error();
    });
    await harness.command.handler("failed run", harness.context);
    await waitFor(() => harness.entries.length === 1);
    expect(harness.entries[0]?.data).toMatchObject({ status: "failed", error: "child failed" });

    await harness.command.handler("could not start", harness.context);
    await waitFor(() => harness.entries.length === 2);
    expect(harness.entries[1]?.data).toMatchObject({ status: "failed", error: "(no output)" });
  });

  it("limits concurrent side questions and frees the slot after settlement", async () => {
    const finishers: Array<(child: FakeChild) => void> = [];
    const harness = createHarness(
      () => new Promise<FakeChild>((resolve) => finishers.push(resolve)),
    );
    for (let index = 0; index < 4; index++)
      await harness.command.handler(`question ${index}`, harness.context);
    await waitFor(() => harness.started.length === 4);

    await harness.command.handler("fifth", harness.context);
    await waitFor(() => harness.notifications.length === 1);
    expect(harness.started).toHaveLength(4);
    expect(harness.notifications).toEqual([
      {
        message: "All subagent execution slots are busy. Try /btw again shortly.",
        type: "warning",
      },
    ]);

    finishers[0]!(answering("done"));
    await flush();
    await harness.command.handler("replacement", harness.context);
    await waitFor(() => harness.started.length === 5);
  });

  it("marks a bounded answer as truncated and leaves an unbounded one alone", async () => {
    const harness = createHarness((_invocation, index) =>
      answering(index === 0 ? "short answer" : "x".repeat(BTW.bytes + 1)),
    );
    await harness.command.handler("short", harness.context);
    await waitFor(() => harness.entries.length === 1);
    expect(harness.entries[0]?.data).toMatchObject({ truncated: false, answer: "short answer" });

    await harness.command.handler("long", harness.context);
    await waitFor(() => harness.entries.length === 2);
    const bounded = harness.entries[1]?.data as { truncated: boolean; answer: string };
    expect(bounded.truncated).toBe(true);
    expect(bounded.answer).toEndWith(BTW.marker);
    expect(Buffer.byteLength(bounded.answer, "utf8")).toBeLessThanOrEqual(BTW.bytes);
  });

  it("aborts active children and suppresses late settlement during shutdown", async () => {
    const finishers: Array<(child: FakeChild) => void> = [];
    const harness = createHarness(
      () => new Promise<FakeChild>((resolve) => finishers.push(resolve)),
    );
    await harness.command.handler("shutdown race", harness.context);
    await waitFor(() => harness.started.length === 1);

    harness.fire("session_shutdown");
    expect(harness.started[0]!.signal?.aborted).toBe(true);

    finishers[0]!(answering("late answer"));
    // Long enough that a leaked settlement would have landed by now.
    await Bun.sleep(10);
    expect(harness.entries).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });
});
