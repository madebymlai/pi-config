/**
 * Stopping a child and everything it started, on both platform families. POSIX targets the
 * detached process group and checks group liveness; Windows waits for taskkill /T and
 * escalates to /F.
 */

import { spawn, type ChildProcess } from "node:child_process";

const PROCESS_TREE_GRACE_MS = 5_000;
const PROCESS_TREE_FORCE_WAIT_MS = 5_000;
const PROCESS_TREE_POLL_MS = 25;

interface TerminateProcessTreeOptions {
  /** Tests can inject a short grace period; production keeps the five-second default. */
  graceMs?: number;
  /** Tests can inject a short forced-exit deadline; production remains bounded at five seconds. */
  forceWaitMs?: number;
  platform?: NodeJS.Platform;
}

export function processTreeKillCommand(
  pid: number,
  force: boolean,
  platform = process.platform,
): { command: string; args: string[] } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "win32")
    return { command: "taskkill", args: ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])] };
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(isAlive: () => boolean, timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (isAlive()) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await sleep(
      deadline === undefined
        ? PROCESS_TREE_POLL_MS
        : Math.max(1, Math.min(PROCESS_TREE_POLL_MS, deadline - Date.now())),
    );
  }
  return true;
}

async function runTaskkill(pid: number, force: boolean, timeoutMs: number): Promise<void> {
  const command = processTreeKillCommand(pid, force, "win32");
  if (!command) return;
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let killer: ChildProcess;
    try {
      killer = spawn(command.command, command.args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    timer = setTimeout(
      () => {
        try {
          killer.kill();
        } catch {
          // The timeout failure below is the actionable termination error.
        }
        settle(
          new Error(
            `taskkill ${force ? "/T /F" : "/T"} timed out for process ${pid} after ${timeoutMs}ms.`,
          ),
        );
      },
      Math.max(1, timeoutMs),
    );
    killer.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    killer.once("error", (error) => settle(error));
    killer.once("close", (code) => {
      if (code === 0) settle();
      else
        settle(
          new Error(
            `taskkill ${force ? "/T /F" : "/T"} failed for process ${pid}${stderr ? `: ${stderr.trim()}` : ` (exit ${code ?? "unknown"})`}`,
          ),
        );
    });
  });
}

/** Terminate a child tree and wait for the tree's whole lifecycle to finish. */
export async function terminateProcessTree(
  proc: Pick<ChildProcess, "pid">,
  {
    graceMs = PROCESS_TREE_GRACE_MS,
    forceWaitMs = PROCESS_TREE_FORCE_WAIT_MS,
    platform = process.platform,
  }: TerminateProcessTreeOptions = {},
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;
  if (platform !== "win32") {
    signalPosixProcessGroup(pid, "SIGTERM");
    if (await waitForExit(() => isPosixProcessGroupAlive(pid), graceMs)) return;
    signalPosixProcessGroup(pid, "SIGKILL");
    if (!(await waitForExit(() => isPosixProcessGroupAlive(pid), forceWaitMs)))
      throw new Error(`Process group ${pid} survived forced termination.`);
    return;
  }

  let gracefulFailure: Error | undefined;
  try {
    await runTaskkill(pid, false, graceMs);
  } catch (error) {
    gracefulFailure = error instanceof Error ? error : new Error(String(error));
  }
  if (!isProcessAlive(pid)) return;

  try {
    await runTaskkill(pid, true, forceWaitMs);
  } catch (error) {
    const forceFailure = error instanceof Error ? error : new Error(String(error));
    if (isProcessAlive(pid))
      throw new Error(
        `Failed to terminate process tree ${pid}: ${gracefulFailure?.message ?? "graceful taskkill did not stop it"}; ${forceFailure.message}`,
      );
  }
  if (!(await waitForExit(() => isProcessAlive(pid), forceWaitMs)))
    throw new Error(`Process tree ${pid} survived forced termination.`);
}
