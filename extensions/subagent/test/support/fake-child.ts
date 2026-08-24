/**
 * Test support for the child-execution engine's one seam.
 *
 * Tests fake the spawn adapter with a scripted NDJSON stream. Capacity stays real:
 * the pool below is a genuine pool with a small limit, so nothing here can run a
 * child without holding a permit.
 */

import { createChildPool, type ChildPool } from "../../engine/index.js";
import type { ChildExit, ChildInvocation } from "../../engine/spawn.js";

export interface FakeChild {
  /** NDJSON lines the child writes before it exits. */
  lines?: string[];
  exit?: Partial<ChildExit>;
}

export function messageLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...extra },
  });
}

export function answering(text: string): FakeChild {
  return { lines: [messageLine(text)] };
}

export function failing(stderr: string, output?: string): FakeChild {
  return { lines: output ? [messageLine(output)] : [], exit: { exitCode: 1, stderr } };
}

/** A real pool over a scripted spawn. `started` records every child that got a permit. */
export function scriptedPool(
  limit: number,
  respond: (invocation: ChildInvocation, index: number) => FakeChild | Promise<FakeChild>,
): { pool: ChildPool; started: ChildInvocation[] } {
  const started: ChildInvocation[] = [];
  const pool = createChildPool(limit, async (invocation, onLine) => {
    const index = started.push(invocation) - 1;
    const child = await respond(invocation, index);
    for (const line of child.lines ?? []) onLine(line);
    return { exitCode: 0, stderr: "", aborted: false, ...child.exit };
  });
  return { pool, started };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for a scripted child.");
}
