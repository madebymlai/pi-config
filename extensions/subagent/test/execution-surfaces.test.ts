import { describe, expect, it } from "bun:test";
import type { ChildInvocation } from "../engine/spawn.js";
import { registerExtension } from "./support/extension-harness.js";
import { scriptedPool, waitFor, type FakeChild } from "./support/fake-child.js";

/**
 * Both callers over one real pool with a small limit. Only the spawn is faked, so nothing
 * here can run a child without first taking a permit from that one pool.
 */
function surfaces(limit: number) {
  const finishers: Array<(child: FakeChild) => void> = [];
  const settledPrompts: string[] = [];
  const { pool, started } = scriptedPool(limit, (invocation: ChildInvocation) => {
    const done = (child: FakeChild) => {
      settledPrompts.push(invocation.prompt);
      return child;
    };
    return new Promise<FakeChild>((resolve) => {
      finishers.push((child) => resolve(done(child)));
      invocation.signal?.addEventListener(
        "abort",
        () => resolve(done({ exit: { exitCode: 1, aborted: true } })),
        { once: true },
      );
    });
  });

  const notifications: string[] = [];
  const { tool, btw, entries, fire } = registerExtension(pool);
  const context = { cwd: process.cwd(), hasUI: false };
  const btwContext = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  fire("session_start", {}, context);

  return {
    started,
    finishers,
    settledPrompts,
    notifications,
    entries,
    askSideQuestion: (question: string) => btw.handler(question, btwContext),
    runTool: (prompt: string, signal?: AbortSignal) =>
      tool.execute("", { prompt }, signal, undefined, context),
    shutdown: () => fire("session_shutdown"),
  };
}

describe("shared execution surfaces", () => {
  it("shares one bound across the subagent tool and /btw", async () => {
    const s = surfaces(2);
    const directController = new AbortController();
    const direct = s.runTool("direct", directController.signal);
    await waitFor(() => s.started.length === 1);
    await s.askSideQuestion("side question");
    await waitFor(() => s.started.length === 2);
    expect(s.started.map((invocation) => invocation.prompt)).toEqual(["direct", "side question"]);

    // The pool is full: a further side question is refused outright, never queued.
    await s.askSideQuestion("second side question");
    await waitFor(() => s.notifications.length === 1);
    expect(s.notifications).toEqual([
      "All subagent execution slots are busy. Try /btw again shortly.",
    ]);
    expect(s.started).toHaveLength(2);

    // A tool call past the bound waits, and an abort while waiting rejects the call.
    const queuedController = new AbortController();
    const queued = s.runTool("queued", queuedController.signal);
    await Bun.sleep(5);
    expect(s.started).toHaveLength(2);
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    // Shutdown cancels what is waiting, and leaves the running children alone.
    const queuedAtShutdown = s.runTool("queued at shutdown");
    await Bun.sleep(5);
    expect(s.started).toHaveLength(2);
    s.shutdown();
    await expect(queuedAtShutdown).rejects.toMatchObject({ name: "AbortError" });
    expect(s.settledPrompts).not.toContain("direct");
    expect(s.started[0]!.signal?.aborted).toBe(false);
    expect(s.started[1]!.signal?.aborted).toBe(true);
    expect(s.entries).toEqual([]);

    directController.abort();
    expect((await direct).details.results[0].stopReason).toBe("aborted");
    expect(s.started).toHaveLength(2);
  });
});
