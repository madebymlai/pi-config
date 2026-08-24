/**
 * Bounded, isolated Pi child execution.
 *
 * One method runs a child: leaf policy, capacity, invocation, NDJSON parsing, usage
 * accounting and process-tree termination all live behind it. It never rejects — every
 * failure is a stop reason — and permits are acquired above the replaceable spawn
 * adapter, so no substituted adapter can run a child without one.
 */

import type { Message } from "@earendil-works/pi-ai";
import { MAX_CONCURRENT_CHILDREN, PermitPool, QUEUE_CANCELLED, type Permit } from "./permits.js";
import {
  acceptLine,
  childArgs,
  createTranscript,
  emptyUsage,
  getFinalText,
  isLeafProcess,
  leafEnvironment,
  type ChildEvent,
  type ChildTranscript,
  type UsageTotals,
} from "./protocol.js";
import { spawnPiChild, type ChildExit, type SpawnChild } from "./spawn.js";

export type { ChildEvent } from "./protocol.js";
/** True inside a spawned child: it may not delegate, and must register no orchestration. */
export { getFinalText, isLeafProcess } from "./protocol.js";

export interface ChildRun {
  /** The complete prompt. The engine never adds to it. */
  prompt: string;
  /** Inert display label; it never selects instructions or defaults. */
  label?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
}

/** Why a child stopped. Anything but "completed" means the run failed. */
type ChildStopReason =
  | "completed"
  | "failed"
  | "aborted"
  | "queue-aborted"
  | "pool-full"
  | "delegation-denied";

export interface ChildResult {
  stopReason: ChildStopReason;
  /** Caller-facing failure text, present exactly when stopReason is not "completed". */
  errorMessage?: string;
  exitCode: number;
  messages: Message[];
  usage: UsageTotals;
  model?: string;
  stderr: string;
  aborted: boolean;
}

/** What a caller controls about one child run. */
interface ChildRunOptions {
  /** Fallback working directory for runs that do not name one. */
  cwd?: string;
  signal?: AbortSignal;
  /** "queue" (the default) waits for a permit; "reject" settles as "pool-full" instead. */
  policy?: "queue" | "reject";
}

export interface ChildPool {
  /** Run one child to completion. Never rejects: every failure arrives as a stop reason. */
  run(
    run: ChildRun,
    progress?: (event: ChildEvent) => void,
    options?: ChildRunOptions,
  ): Promise<ChildResult>;
  /** Settle everything waiting for a permit. Children already running are untouched. */
  cancelQueued(reason?: string): void;
}

/** The ` "label"` fragment that names a child mid-sentence, empty when it has no label. */
function labelSuffix(label: string | undefined): string {
  return label ? ` "${label}"` : "";
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "(no output)";
}

function classify(exit: ChildExit, transcript: ChildTranscript): ChildStopReason {
  if (exit.aborted || transcript.stopReason === "aborted") return "aborted";
  if (exit.exitCode !== 0 || transcript.stopReason === "error") return "failed";
  return "completed";
}

/** The most specific failure text available: the child's own, then the transport's, then output. */
function failureText(exit: ChildExit, transcript: ChildTranscript): string {
  return (
    transcript.errorMessage ||
    exit.errorMessage ||
    exit.stderr ||
    getFinalText({ messages: transcript.messages }, "") ||
    "(no output)"
  );
}

/** An independent pool. Tests substitute the spawn adapter; capacity stays real. */
export function createChildPool(
  limit = MAX_CONCURRENT_CHILDREN,
  spawn: SpawnChild = spawnPiChild,
): ChildPool {
  const permits = new PermitPool(limit);

  const refuse = (
    stopReason: ChildStopReason,
    errorMessage: string,
    run: ChildRun,
    aborted = false,
  ): ChildResult => ({
    stopReason,
    errorMessage,
    exitCode: 1,
    messages: [],
    usage: emptyUsage(),
    model: run.model,
    stderr: "",
    aborted,
  });

  const execute = async (
    run: ChildRun,
    progress: ((event: ChildEvent) => void) | undefined,
    options: ChildRunOptions,
  ): Promise<ChildResult> => {
    const transcript = createTranscript();
    let exit: ChildExit;
    try {
      exit = await spawn(
        {
          cwd: run.cwd ?? options.cwd ?? process.cwd(),
          prompt: run.prompt,
          args: childArgs(run),
          env: leafEnvironment(),
          signal: options.signal,
        },
        (line) => acceptLine(transcript, line, progress),
      );
    } catch (error) {
      return refuse("failed", messageOf(error), run);
    }
    const stopReason = classify(exit, transcript);
    return {
      stopReason,
      errorMessage: stopReason === "completed" ? undefined : failureText(exit, transcript),
      exitCode: exit.exitCode,
      messages: transcript.messages,
      usage: transcript.usage,
      model: transcript.model ?? run.model,
      stderr: exit.stderr,
      aborted: exit.aborted,
    };
  };

  const attempt = async (
    run: ChildRun,
    progress: ((event: ChildEvent) => void) | undefined,
    options: ChildRunOptions,
  ): Promise<ChildResult> => {
    // Leaf policy precedes capacity: a refused delegation never consumes a permit.
    if (isLeafProcess())
      return refuse(
        "delegation-denied",
        `Subagent${labelSuffix(run.label)} cannot start: spawned agents are leaves and cannot delegate to another agent.`,
        run,
      );

    let permit: Permit;
    if (options.policy === "reject") {
      const immediate = permits.tryAcquire();
      if (!immediate)
        return refuse(
          "pool-full",
          `Subagent${labelSuffix(run.label)} cannot start: all ${limit} execution slots are busy.`,
          run,
        );
      permit = immediate;
    } else {
      try {
        permit = await permits.acquire(options.signal);
      } catch (error) {
        return refuse("queue-aborted", messageOf(error), run, true);
      }
    }

    try {
      return await execute(run, progress, options);
    } finally {
      permit.release();
    }
  };

  return {
    run(run, progress, options = {}) {
      // The never-rejects contract is enforced here rather than merely observed:
      // nothing thrown below this point can reach the caller as a rejection.
      return attempt(run, progress, options).catch((error) =>
        refuse("failed", messageOf(error), run),
      );
    },
    cancelQueued(reason = QUEUE_CANCELLED) {
      permits.cancelWaiting(reason);
    },
  };
}

/** The process-wide pool. Every caller in this extension shares these permits. */
export const childPool = createChildPool();
