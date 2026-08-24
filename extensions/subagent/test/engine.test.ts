import { describe, expect, it } from "bun:test";
import { getFinalText } from "../engine/index.js";
import { createChildPool, type ChildEvent, type ChildResult } from "../engine/index.js";
import type { ChildExit, ChildInvocation } from "../engine/spawn.js";
import { messageLine, waitFor } from "./support/fake-child.js";

const AGENT_LEAF_ENV = "PI_AGENT_LEAF";

function toolResultLine(text: string): string {
  return JSON.stringify({
    type: "tool_result_end",
    message: { role: "toolResult", content: [{ type: "text", text }] },
  });
}

function completed(exit: Partial<ChildExit> = {}): ChildExit {
  return { exitCode: 0, stderr: "", aborted: false, ...exit };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** A pool whose children only finish when the test says so. */
function blockingPool(limit: number) {
  const started: ChildInvocation[] = [];
  const finishers: Array<(exit: ChildExit) => void> = [];
  const pool = createChildPool(limit, async (invocation) => {
    started.push(invocation);
    const child = deferred<ChildExit>();
    finishers.push(child.resolve);
    return child.promise;
  });
  return { pool, started, finishers };
}

function withLeafMarker<T>(body: () => T): T {
  const previous = process.env[AGENT_LEAF_ENV];
  process.env[AGENT_LEAF_ENV] = "1";
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[AGENT_LEAF_ENV];
    else process.env[AGENT_LEAF_ENV] = previous;
  }
}

describe("child execution engine", () => {
  it("parses the child's own NDJSON stream into output, usage, and model", async () => {
    const pool = createChildPool(1, async (_invocation, onLine) => {
      onLine(
        messageLine("hello", {
          model: "openai/test",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 1,
            cacheWrite: 2,
            cost: { total: 0.5 },
            totalTokens: 14,
          },
        }),
      );
      onLine("this line is not JSON");
      onLine("   ");
      return completed();
    });

    const result = await pool.run({ prompt: "ask" });

    expect(result.stopReason).toBe("completed");
    expect(result.errorMessage).toBeUndefined();
    expect(getFinalText(result)).toBe("hello");
    expect(result.usage).toEqual({
      input: 10,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      cost: 0.5,
      contextTokens: 14,
      turns: 1,
    });
    expect(result.model).toBe("openai/test");
  });

  it("delivers assistant messages and tool results as one opt-in event stream", async () => {
    const pool = createChildPool(1, async (_invocation, onLine) => {
      onLine(messageLine("thinking out loud"));
      onLine(toolResultLine("read a file"));
      onLine(messageLine("done"));
      return completed();
    });
    const events: ChildEvent[] = [];

    const result = await pool.run({ prompt: "ask" }, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual(["message", "tool-result", "message"]);
    expect(result.messages).toHaveLength(3);
  });

  it("transports the prompt over stdin and keeps orchestration tools out of the child", async () => {
    let invocation: ChildInvocation | undefined;
    const pool = createChildPool(1, async (received) => {
      invocation = received;
      return completed();
    });

    await pool.run({
      prompt: "Keep this exact.",
      model: "openai/test",
      thinking: "low",
      tools: ["read"],
      cwd: "/fixture",
    });

    expect(invocation?.prompt).toBe("Keep this exact.");
    expect(invocation?.cwd).toBe("/fixture");
    expect(invocation?.args.join(" ")).not.toContain("Keep this exact.");
    expect(invocation?.args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-prompt-templates",
      "--model",
      "openai/test",
      "--thinking",
      "low",
      "--tools",
      "read",
      "--exclude-tools",
      "subagent,subagent_spawn,subagent_wait,subagent_cancel,subagent_check,subagent_list,workflow",
    ]);
    expect(invocation?.env[AGENT_LEAF_ENV]).toBe("1");
    // The marker is added to the parent environment, not substituted for it.
    expect(invocation?.env.PATH).toBe(process.env.PATH);

    await pool.run({ prompt: "no tools", tools: [] });
    expect(invocation?.args).toContain("--no-tools");
    expect(invocation?.args).not.toContain("--tools");
  });

  it("refuses a nested delegation before it can consume a permit", async () => {
    const { pool, started } = blockingPool(1);
    void pool.run({ prompt: "occupies the only permit" });
    await waitFor(() => started.length === 1);

    // A queued run would never settle here, because the only permit is still held.
    const denied = await withLeafMarker(() =>
      pool.run({ prompt: "delegate again", label: "worker" }),
    );

    expect(denied.stopReason).toBe("delegation-denied");
    expect(denied.errorMessage).toContain("spawned agents are leaves");
    expect(started).toHaveLength(1);
  });

  it("queues past the limit and hands each freed permit to the next waiter", async () => {
    const { pool, started, finishers } = blockingPool(2);
    const runs = ["one", "two", "three"].map((prompt) => pool.run({ prompt }));

    await waitFor(() => started.length === 2);
    await Bun.sleep(5);
    expect(started).toHaveLength(2);

    finishers[0]!(completed());
    await waitFor(() => started.length === 3);
    for (const finish of finishers.slice(1)) finish(completed());
    expect((await Promise.all(runs)).map((result) => result.stopReason)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("settles as pool-full under the reject policy instead of waiting", async () => {
    const { pool, started, finishers } = blockingPool(1);
    void pool.run({ prompt: "holds the permit" });
    await waitFor(() => started.length === 1);

    const refused = await pool.run({ prompt: "side question" }, undefined, { policy: "reject" });

    expect(refused.stopReason).toBe("pool-full");
    expect(refused.errorMessage).toContain("execution slots are busy");
    expect(started).toHaveLength(1);
    finishers[0]!(completed());
  });

  it("settles as queue-aborted when the signal fires while waiting for a permit", async () => {
    const { pool, started, finishers } = blockingPool(1);
    void pool.run({ prompt: "holds the permit" });
    await waitFor(() => started.length === 1);
    const controller = new AbortController();
    const queued = pool.run({ prompt: "waiting" }, undefined, { signal: controller.signal });

    controller.abort();
    const result = await queued;

    expect(result.stopReason).toBe("queue-aborted");
    expect(result.aborted).toBe(true);
    expect(started).toHaveLength(1);
    finishers[0]!(completed());
  });

  it("cancels queued waiters on shutdown without disturbing running children", async () => {
    const { pool, started, finishers } = blockingPool(1);
    const running = pool.run({ prompt: "already running" });
    await waitFor(() => started.length === 1);
    const queued = pool.run({ prompt: "still waiting" });

    pool.cancelQueued();

    expect(await queued).toMatchObject({ stopReason: "queue-aborted" });
    expect((await queued).errorMessage).toContain("session ended");
    finishers[0]!(completed());
    expect(await running).toMatchObject({ stopReason: "completed" });
    expect(started).toHaveLength(1);
  });

  it("settles rather than rejects when a child's output or its adapter is malformed", async () => {
    const malformed = await createChildPool(1, async (_invocation, onLine) => {
      // A message_end carrying no content: dropped at the boundary, never seen by a caller.
      onLine(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
      return completed({ exitCode: 1 });
    }).run({ prompt: "x" });
    expect(malformed.stopReason).toBe("failed");
    expect(malformed.messages).toHaveLength(0);

    // An adapter that breaks its own contract still must not surface as a rejection.
    const broken = await createChildPool(1, async () => undefined as never).run({ prompt: "x" });
    expect(broken.stopReason).toBe("failed");
  });

  it("returns every failure as a settled result rather than a rejection", async () => {
    const failures: Array<[string, () => Promise<ChildResult>]> = [
      [
        "failed",
        () =>
          createChildPool(1, async () => completed({ exitCode: 1, stderr: "child failed" })).run({
            prompt: "x",
          }),
      ],
      [
        "failed",
        () =>
          createChildPool(1, async (_invocation, onLine) => {
            onLine(
              messageLine("partial", { stopReason: "error", errorMessage: "provider exploded" }),
            );
            return completed();
          }).run({ prompt: "x" }),
      ],
      [
        "aborted",
        () => createChildPool(1, async () => completed({ aborted: true })).run({ prompt: "x" }),
      ],
      [
        "failed",
        () =>
          createChildPool(1, async () => {
            throw new Error("could not spawn pi");
          }).run({ prompt: "x" }),
      ],
    ];

    const results = await Promise.all(failures.map(([, run]) => run()));

    expect(results.map((result) => result.stopReason)).toEqual(failures.map(([reason]) => reason));
    expect(results[0]!.errorMessage).toBe("child failed");
    expect(results[1]!.errorMessage).toBe("provider exploded");
    expect(results[3]!.errorMessage).toBe("could not spawn pi");
  });
});
