import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { processTreeKillCommand } from "../engine/process-tree.js";
import { spawnPiChild } from "../engine/spawn.js";

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number.parseInt(await readFile(file, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The fixture has not written its descendant PID yet.
    }
    await Bun.sleep(10);
  }
  throw new Error("Fixture did not report its descendant PID.");
}

describe("process-tree cancellation", () => {
  it("constructs Windows tree-kill commands with graceful and forced phases", () => {
    expect(processTreeKillCommand(42, false, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "42", "/t"],
    });
    expect(processTreeKillCommand(42, true, "win32")).toEqual({
      command: "taskkill",
      args: ["/pid", "42", "/t", "/f"],
    });
    expect(processTreeKillCommand(0, false, "win32")).toBeUndefined();
  });

  it("does not resolve cancellation until the automatic lifecycle kills a graceful-resistant orphan", async () => {
    if (process.platform === "win32") return;
    const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "pi-subagent-process-tree-"));
    const pidFile = join(directory, "descendant.pid");
    const originalScript = process.argv[1];
    process.argv[1] = fixture;
    const controller = new AbortController();
    try {
      const run = spawnPiChild(
        {
          cwd: process.cwd(),
          prompt: "",
          args: [],
          env: { ...process.env, PROCESS_TREE_PID_FILE: pidFile },
          signal: controller.signal,
          terminationGraceMs: 25,
          terminationForceWaitMs: 1_000,
        },
        () => {},
      );
      const child = await waitForPid(pidFile);
      controller.abort();
      const result = await run;
      expect(result.aborted).toBe(true);
      expect(() => process.kill(child, 0)).toThrow();
    } finally {
      process.argv[1] = originalScript!;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
