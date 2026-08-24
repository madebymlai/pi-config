/**
 * The engine's one replaceable part: start a Pi child, stream its NDJSON lines, and
 * resolve once the whole process tree has finished. It sits beneath capacity, so a
 * substituted adapter still runs under a real permit.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { terminateProcessTree } from "./process-tree.js";

export interface ChildInvocation {
  cwd: string;
  prompt: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Injectable only for lifecycle tests. */
  terminationGraceMs?: number;
  /** Injectable only for lifecycle tests. */
  terminationForceWaitMs?: number;
}

export interface ChildExit {
  exitCode: number;
  stderr: string;
  aborted: boolean;
  /** Set when the transport or the termination failed rather than the child itself. */
  errorMessage?: string;
}

export type SpawnChild = (
  invocation: ChildInvocation,
  onLine: (line: string) => void,
) => Promise<ChildExit>;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualPath = currentScript?.startsWith("/$bunfs/");

  if (currentScript && !isBunVirtualPath && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

/** Spawn Pi and send the caller-provided complete prompt, unchanged, over stdin. */
export const spawnPiChild: SpawnChild = (invocation, onLine) =>
  new Promise<ChildExit>((resolve) => {
    const exit: ChildExit = { exitCode: 0, stderr: "", aborted: false };
    const piInvocation = getPiInvocation(invocation.args);
    const needsShell = process.platform === "win32" && piInvocation.command === "pi";
    const proc = spawn(piInvocation.command, piInvocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: needsShell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let stdinErrored = false;
    let abortRequested = false;
    let termination: Promise<void> | undefined;
    let terminationFailed = false;
    let finalizing = false;

    const removeAbortListener = () => invocation.signal?.removeEventListener("abort", killProc);
    const recordFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      exit.errorMessage ??= message;
      exit.stderr += exit.stderr ? `\n${message}` : message;
    };
    const finish = (exitCode: number) => {
      if (settled || finalizing) return;
      finalizing = true;
      void (async () => {
        try {
          await termination;
          if (buffer.trim()) onLine(buffer);
        } catch (error) {
          terminationFailed = true;
          recordFailure(error);
          exitCode = 1;
        } finally {
          settled = true;
          removeAbortListener();
          exit.exitCode = terminationFailed ? 1 : exitCode;
          resolve(exit);
        }
      })();
    };

    proc.stdout.on("data", (data: Buffer) => {
      try {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) onLine(line);
      } catch (error) {
        recordFailure(error);
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      exit.stderr += data.toString();
    });
    proc.stdin.once("error", (error) => {
      stdinErrored = true;
      exit.errorMessage ??= error.message;
      exit.stderr += error.message;
    });
    proc.once("close", (code) => finish(stdinErrored ? 1 : (code ?? 1)));
    proc.once("error", (error) => {
      recordFailure(error);
      finish(1);
    });

    function killProc(): void {
      if (abortRequested) return;
      abortRequested = true;
      exit.aborted = true;
      termination = terminateProcessTree(proc, {
        graceMs: invocation.terminationGraceMs,
        forceWaitMs: invocation.terminationForceWaitMs,
      });
      void termination.catch(() => finish(1));
    }
    if (invocation.signal) {
      if (invocation.signal.aborted) killProc();
      else invocation.signal.addEventListener("abort", killProc, { once: true });
    }

    // end() is intentional: Pi reads the whole prompt from stdin before executing it.
    proc.stdin.end(invocation.prompt, "utf8");
  });
