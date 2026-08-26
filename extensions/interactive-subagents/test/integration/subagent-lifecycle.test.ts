/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (haiku by default).
 * Each test creates a tmux pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (haiku).
 * Duration: ~30-90s per test.
 *
 * Run inside tmux:
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions, parent and subagent
 *                       (default: deepseek/deepseek-v4-flash)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

/**
 * Find the parent session's transcript and wait for it to record a
 * subagent_result. `startPi` lets pi choose its own session file, so the
 * parent is identified by content: it is the only transcript written during
 * this test that carries the test's unique id.
 */
async function waitForParentResult(
  id: string,
  startedAt: number,
  timeoutMs: number,
): Promise<any | null> {
  const root = join(homedir(), ".pi", "agent", "sessions");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const dir of existsSync(root) ? readdirSync(root) : []) {
      const sessionDir = join(root, dir);
      let files: string[] = [];
      try {
        files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = join(sessionDir, file);
        let raw = "";
        try {
          if (statSync(full).mtimeMs < startedAt) continue;
          raw = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        // The parent is the transcript holding this test's task text.
        if (!raw.includes(id)) continue;
        for (const line of raw.trim().split("\n")) {
          let entry: any;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry?.customType === "subagent_result") return entry;
        }
      }
    }
    await sleep(1000);
  }
  return null;
}

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping subagent lifecycle integration tests");
  console.log("   Run inside tmux to enable these tests.");

  // Register the skip explicitly. A file that defines no tests still counts as
  // one passing test, so an unregistered suite reports as a pass and reads like
  // it ran. This makes the runner say skipped instead.
  describe("subagent lifecycle", () => {
    it("needs a tmux session", { skip: "not running inside tmux (TMUX is unset)" }, () => {});
  });
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    /**
     * The delivery half of a spawn, which nothing else covers.
     *
     * Every other test here proves the CHILD ran: it checks a marker file, or
     * the child's own session. None of them prove the PARENT was ever told.
     * Those are separate mechanisms — the child writes its transcript and
     * exits, then the parent's watcher has to notice and steer the result in —
     * and the second one can fail on its own, leaving a session that waits
     * forever on a subagent that finished minutes ago.
     *
     * The assertion is deliberately on the parent's transcript rather than its
     * screen. A screen regex matches whatever the widget or status line happens
     * to be painting, so it can go green while nothing was delivered; the
     * subagent_result entry exists only if reportResult actually ran.
     */
    it("delivers the result into the parent's own transcript, not just the screen", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-deliver-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `deliver-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Deliver-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
      ].join("\n");

      const startedAt = Date.now();
      startPi(surface, env.dir, task);

      // The child finished. Whether the parent hears about it is the question.
      await waitForFile(markerFile, PI_TIMEOUT, /PASS/);

      const entry = await waitForParentResult(id, startedAt, PI_TIMEOUT);
      assert.ok(
        entry,
        `The parent never recorded a subagent_result for Deliver-${id}. The child ` +
          `finished (marker file written) but the result was never steered back, ` +
          `so the session would wait on it forever.`,
      );
      assert.equal(entry.details?.name, `Deliver-${id}`, "result should name the subagent it came from");
    });

    /**
     * The same delivery, but with the parent guaranteed idle when the result
     * lands. The test above lets the child finish in seconds, while the parent
     * is often still mid-turn, so a steer has a live turn to land in. Here the
     * child sleeps well past the parent's last word, which is the ordinary case
     * for any real research or implementation task.
     */
    it("delivers the result when the parent has gone idle waiting", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-idle-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `idle-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Idle-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command and wait for it: sleep 45 && echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once, then stop and say SPAWNED.`,
      ].join("\n");

      const startedAt = Date.now();
      startPi(surface, env.dir, task);

      await waitForFile(markerFile, PI_TIMEOUT, /PASS/);

      const entry = await waitForParentResult(id, startedAt, PI_TIMEOUT);
      assert.ok(
        entry,
        `The parent never recorded a subagent_result for Idle-${id}. The child ` +
          `finished long after the parent's turn ended, which is when a steer has ` +
          `no live turn to land in.`,
      );
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent parameter. Just set name, fork, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });
  });
}
