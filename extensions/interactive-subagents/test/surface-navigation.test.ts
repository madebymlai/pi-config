import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import subagentsExtension from "../index.ts";
import { paths } from "../paths.ts";
import { createChildren } from "../spawn/children.ts";
import { createSurface, shellEscape } from "../spawn/tmux.ts";
import type { SubagentLiveness } from "../observe/liveness.ts";
import { createMockContext, createMockExtensionApi } from "./support/mock-extension-api.ts";

// No provider calls: a real Pi editor is left idle in each child pane.
it("click opens an agent; empty left and Ctrl+Alt+A return without losing a draft", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-navigation-test-"));
  const socket = join(dir, "socket");
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const mock = createMockExtensionApi();
  const { ctx } = createMockContext();
  ctx.mode = "tui";
  const children = createChildren();
  const waitUntil = async (check: () => boolean, detail: () => string) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      assert.ok(Date.now() < deadline, detail());
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  try {
    const main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "navigation", "-x", "180", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = main;
    subagentsExtension(mock.api, { children });
    await mock.emit("session_start", {}, ctx);
    const a = createSurface("Scout");
    const b = createSurface("Worker");
    const visible = () => tmux("list-panes", "-t", main, "-F", "#{pane_id}").split("\n");
    const list = visible().find((id) => id !== main)!;
    const screen = (pane: string) => tmux("capture-pane", "-p", "-t", pane);
    const cli = process.env.PI_TEST_CLI ?? resolve(paths.root, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    for (const [pane, name] of [[a, "Scout"], [b, "Worker"]]) {
      const command = `cd ${shellEscape(dir)} && PI_CODING_AGENT_DIR=${shellEscape(join(dir, "config"))} PI_SUBAGENT_NAME=${shellEscape(name)} ${shellEscape(process.execPath)} ${shellEscape(cli)} --no-extensions --no-skills --no-prompt-templates --no-themes -e ${shellEscape(paths.childEntry)} --session ${shellEscape(join(dir, `${name}.jsonl`))}`;
      tmux("respawn-pane", "-k", "-t", pane, command);
      await children.launch({
        base: name,
        start: async () => ({
          id: pane, name, surface: pane, task: "", startTime: Date.now(),
          sessionFile: join(dir, `${name}.jsonl`), launchScriptFile: "",
          liveness: {
            snapshot: () => ({ kind: "waiting", statusLabel: "waiting", elapsedMs: 0 }),
            observe() {}, tick: () => ({ transition: null }),
          } as unknown as SubagentLiveness,
        }),
        watch: () => new Promise<void>(() => {}),
      });
    }
    await waitUntil(() => screen(list).includes("Worker") && screen(b).includes("Ctrl+Alt+A"), () => `List:\n${screen(list)}\nChild:\n${screen(b)}`);
    assert.deepEqual(visible(), [main, list]);
    assert.equal(tmux("display-message", "-p", "-t", main, "#{pane_active}"), "1");

    // Click the rendered Worker row through the real TUI's mouse dispatch.
    const workerRow = screen(list).split("\n").findIndex((line) => line.includes("Worker")) + 1;
    assert.ok(workerRow > 0);
    tmux("send-keys", "-t", list, "-l", `\x1b[<0;3;${workerRow}M\x1b[<0;3;${workerRow}m`);
    await waitUntil(() => visible().includes(b), () => screen(list));
    const pid = tmux("display-message", "-p", "-t", b, "#{pane_pid}");
    tmux("send-keys", "-t", b, "-l", "draft");
    tmux("send-keys", "-t", b, "Left");
    tmux("send-keys", "-t", b, "-l", "X");
    await waitUntil(() => screen(b).includes("drafXt"), () => screen(b));
    assert.ok(visible().includes(b), "left in a non-empty prompt must edit, not navigate away");
    tmux("send-keys", "-t", b, "-l", "\x1b\x01"); // Ctrl+Alt+A
    await waitUntil(() => visible().includes(list), () => screen(b));
    assert.equal(tmux("display-message", "-p", "-t", b, "#{pane_pid}"), pid, "returning must not restart the agent");
    tmux("send-keys", "-t", list, "Enter");
    await waitUntil(() => visible().includes(b), () => screen(list));
    assert.ok(screen(b).includes("drafXt"), "the draft survives switching views");
    tmux("send-keys", "-t", b, "C-e", "C-u", "Left");
    await waitUntil(() => visible().includes(list), () => screen(b));
    tmux("send-keys", "-t", list, "Left", "Left", "Left", "Down");
    await waitUntil(() => screen(list).includes("→ Scout"), () => screen(list));
    assert.equal(tmux("display-message", "-p", "-t", list, "#{pane_active}"), "1", "left repeats must not bounce focus back to main");
    tmux("send-keys", "-t", list, "Escape");
    await waitUntil(() => tmux("display-message", "-p", "-t", main, "#{pane_active}") === "1", () => "main did not regain focus");
    await mock.emit("session_shutdown", {}, ctx);
    assert.deepEqual(visible(), [main]);
    assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "navigation");
  } finally {
    await mock.emit("session_shutdown", {}, ctx);
    try { tmux("kill-server"); } catch {}
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
