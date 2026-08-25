import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeSurface,
  createSurface,
  createSurfaceSplit,
  isMuxAvailable,
  muxSetupHint,
  muxUnavailableMessage,
  pollForExit,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendLongCommand,
  shellEscape,
  __pollForExitTest__,
} from "../spawn/tmux.ts";

/**
 * Everything here runs with TMUX deliberately unset.
 *
 * The pane-driving half of this module needs a live tmux server and is covered
 * by test/integration/tmux-surface.test.ts, which only runs inside a tmux
 * session. That leaves the half nobody was testing: the guards that decide
 * whether to touch tmux at all, the strings shown when it is missing, and the
 * exit-polling fast path that never reads a screen.
 */

let savedTmux: string | undefined;

beforeEach(() => {
  savedTmux = process.env.TMUX;
  delete process.env.TMUX;
});

afterEach(() => {
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tmux-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("spawn/tmux.ts", () => {
  describe("availability", () => {
    it("is unavailable outside a tmux session, even with tmux installed", () => {
      // TMUX is set by tmux in every process it spawns. Having the binary on
      // PATH is not enough: there is no server to attach a pane to.
      assert.equal(isMuxAvailable(), false);
    });

    it("says what to do about it, once", () => {
      const message = muxUnavailableMessage();
      assert.match(message, /tmux/);
      assert.ok(
        message.includes(muxSetupHint()),
        "the refusal and the transport failure both quote the hint, so it must be composed from it",
      );
    });

    it("gives a hint that is a runnable command", () => {
      assert.match(muxSetupHint(), /tmux new/);
    });
  });

  describe("refusing to act without tmux", () => {
    /**
     * Every export that drives a pane, with a call that reaches its guard.
     *
     * Exhaustive on purpose: a new pane-driving export that forgets its guard
     * would otherwise shell out to a tmux that is not there and fail with
     * whatever execFileSync happens to throw, instead of saying what is wrong.
     */
    const PANE_DRIVERS: Array<[string, () => unknown]> = [
      ["createSurface", () => createSurface("worker")],
      ["createSurfaceSplit", () => createSurfaceSplit("worker", "right")],
      ["sendCommand", () => sendCommand("%1", "echo hi")],
      ["readScreen", () => readScreen("%1")],
      ["closeSurface", () => closeSurface("%1")],
    ];

    for (const [name, call] of PANE_DRIVERS) {
      it(`${name} refuses, naming tmux`, () => {
        assert.throws(call, /tmux is required for subagents/);
      });
    }

    it("readScreenAsync refuses too, as a rejection", async () => {
      await assert.rejects(readScreenAsync("%1"), /tmux is required for subagents/);
    });

    it("sendLongCommand keeps the script it wrote, even though sending failed", () => {
      withTempDir((dir) => {
        // The script is the exact invocation; losing it on a send failure would
        // throw away the one artifact worth reading afterwards.
        const scriptPath = join(dir, "cmd.sh");
        assert.throws(
          () => sendLongCommand("%1", "echo hi", { scriptPath }),
          /tmux is required for subagents/,
        );
        assert.ok(existsSync(scriptPath), "the script should survive the failure");
      });
    });
  });

  describe("the script it sends", () => {
    const write = (dir: string, command: string, preamble?: string) => {
      const scriptPath = join(dir, "cmd.sh");
      try {
        sendLongCommand("%1", command, { scriptPath, scriptPreamble: preamble });
      } catch {
        // Sending needs tmux; writing the script does not.
      }
      return readFileSync(scriptPath, "utf8");
    };

    it("is a bash script ending in the command", () => {
      withTempDir((dir) => {
        const script = write(dir, "pi --print 'hello'");
        assert.match(script, /^#!\/bin\/bash\n/);
        assert.match(script, /pi --print 'hello'\n$/);
      });
    });

    it("puts the preamble before the command", () => {
      withTempDir((dir) => {
        const script = write(dir, "run-me", "export FOO=1\nexport BAR=2");
        const lines = script.trim().split("\n");
        assert.deepEqual(lines, ["#!/bin/bash", "export FOO=1", "export BAR=2", "run-me"]);
      });
    });

    it("is executable, since it is run as a script and not sourced", () => {
      withTempDir((dir) => {
        write(dir, "run-me");
        assert.equal(statSync(join(dir, "cmd.sh")).mode & 0o755, 0o755);
      });
    });

    it("creates the directory the caller asked for", () => {
      withTempDir((dir) => {
        const scriptPath = join(dir, "nested", "deeper", "cmd.sh");
        try {
          sendLongCommand("%1", "run-me", { scriptPath });
        } catch {}
        assert.ok(existsSync(scriptPath));
      });
    });
  });

  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes by closing, escaping, reopening", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles an empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("leaves everything else literal, which is the point", () => {
      const escaped = shellEscape('echo "hello $world" && rm -rf /');
      assert.ok(escaped.startsWith("'") && escaped.endsWith("'"));
      assert.ok(escaped.includes("$world"), "no expansion inside single quotes");
      assert.ok(escaped.includes("&& rm -rf /"), "no command separation either");
    });

    it("survives a string that is only quotes", () => {
      assert.equal(shellEscape("'''"), "''\\'''\\'''\\'''");
    });

    it("keeps newlines, which a pane would otherwise submit as Enter", () => {
      assert.ok(shellEscape("a\nb").includes("\n"));
    });
  });

  describe("reading an exit sidecar", () => {
    const { interpretExitSidecar } = __pollForExitTest__;

    it("reads a clean payload as done", () => {
      assert.deepEqual(interpretExitSidecar({ type: "done" }), { reason: "done", exitCode: 0 });
    });

    it("reads an error payload as a non-zero failure carrying its message", () => {
      assert.deepEqual(interpretExitSidecar({ type: "error", errorMessage: "overloaded" }), {
        reason: "error",
        exitCode: 1,
        errorMessage: "overloaded",
      });
    });

    it("invents a message rather than reporting an error with none", () => {
      const result = interpretExitSidecar({ type: "error" });
      assert.equal(result.reason, "error");
      assert.match(result.errorMessage ?? "", /stopReason=error/);
    });

    it("treats a blank message as no message", () => {
      assert.match(
        interpretExitSidecar({ type: "error", errorMessage: "   " }).errorMessage ?? "",
        /stopReason=error/,
      );
    });
  });

  describe("polling for exit", () => {
    it("finds the sidecar without ever reading a screen", async () => {
      await withTempDir(async (dir) => {
        // The fast path is what makes this reachable without tmux at all: a
        // subagent that failed has already written its verdict to disk.
        const sessionFile = join(dir, "session.jsonl");
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "boom" }));

        const result = await pollForExit("%1", new AbortController().signal, {
          interval: 5,
          sessionFile,
        });

        assert.deepEqual(result, { reason: "error", exitCode: 1, errorMessage: "boom" });
      });
    });

    it("consumes the sidecar, so a later run cannot read a stale verdict", async () => {
      await withTempDir(async (dir) => {
        const sessionFile = join(dir, "session.jsonl");
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));

        await pollForExit("%1", new AbortController().signal, { interval: 5, sessionFile });

        assert.equal(existsSync(`${sessionFile}.exit`), false);
      });
    });

    it("stops when the caller aborts", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        pollForExit("%1", controller.signal, { interval: 5 }),
        /Aborted/,
      );
    });

    it("aborts a wait that is already in progress", async () => {
      await withTempDir(async (dir) => {
        // No sidecar and no tmux, so it can only be sitting in its interval.
        const controller = new AbortController();
        const pending = pollForExit("%1", controller.signal, {
          interval: 10_000,
          sessionFile: join(dir, "session.jsonl"),
        });
        setTimeout(() => controller.abort(), 20);

        await assert.rejects(pending, /Aborted/);
      });
    });

    it("reports elapsed seconds while it waits", async () => {
      await withTempDir(async (dir) => {
        const ticks: number[] = [];
        const controller = new AbortController();
        const pending = pollForExit("%1", controller.signal, {
          interval: 5,
          sessionFile: join(dir, "session.jsonl"),
          onTick: (elapsed) => {
            ticks.push(elapsed);
            if (ticks.length >= 2) controller.abort();
          },
        });

        await assert.rejects(pending, /Aborted/);
        assert.ok(ticks.length >= 2, `expected repeated ticks, got ${ticks.length}`);
        assert.ok(ticks.every((t) => t >= 0), "elapsed should never be negative");
      });
    });
  });
});
