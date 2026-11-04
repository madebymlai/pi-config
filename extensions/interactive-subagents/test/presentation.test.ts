import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagents from "../index.ts";
import { createChildren } from "../spawn/children.ts";
import { disposeSurfaces, shellEscape } from "../spawn/tmux.ts";
import { registerName } from "../store/name-registry.ts";
import { createMockContext, createMockExtensionApi } from "./support/mock-extension-api.ts";

it("loads the shipped footer for both fresh and resumed restricted agents", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-presentation-"));
  const socket = join(dir, "socket");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const children = createChildren();
  let started = false;
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Replace only the external Pi executable: observe the actual launch argv on its terminal.
    writeFileSync(join(bin, "pi"), '#!/bin/sh\nprintf "ARG: %s\\n" "$@"\nprintf "MOCK_PI_READY\\n"\nexec sleep 600\n', { mode: 0o755 });
    const main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "presentation", "-x", "180", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
    started = true;
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    tmux("set-option", "-g", "default-command", `exec env PATH=${shellEscape(`${bin}:${process.env.PATH}`)} /bin/sh`);
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = main;
    process.env.PI_CODING_AGENT_DIR = dir;
    const mock = createMockExtensionApi();
    const { ctx } = createMockContext({ sessionDir: dir, sessionId: "parent" });
    ctx.cwd = dir;
    ctx.sessionManager.getSessionFile = () => join(dir, "parent.jsonl");
    subagents(mock.api, { children });
    const launchedArgv = async (name: string) => {
      const pane = children.live().find(child => child.name === name)!.surface;
      const deadline = Date.now() + 5000;
      let screen = "";
      do {
        screen = tmux("capture-pane", "-p", "-J", "-t", pane);
        if (screen.includes("MOCK_PI_READY")) return screen;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.fail(`Pi launcher did not start:\n${screen}`);
    };
    const spawn = mock.registeredTools.find(tool => tool.name === "subagent")!;
    await spawn.execute("fresh", { agent: "scout", name: "Fresh", task: "inspect" }, undefined, undefined, ctx);
    const fresh = await launchedArgv("Fresh");
    assert.match(fresh, /ARG: --no-extensions/);
    assert.match(fresh, /ARG: .*powerline-footer\/index\.ts/, "fresh agents need the footer despite disabled discovery");

    const session = join(dir, "finished.jsonl");
    writeFileSync(session, "");
    writeFileSync(`${session}.loadout.json`, JSON.stringify({ agent: "worker", toolAllowlist: "read", model: null, thinking: null, systemPromptMode: null, identity: null, autoExit: true, cwd: dir, agentDir: dir }));
    registerName(join(dir, "artifacts", "parent"), "Resumed", { sessionFile: session, sessionId: "finished" });
    const send = mock.registeredTools.find(tool => tool.name === "send_message")!;
    const result = await send.execute("resume", { to: "Resumed", message: "continue" }, undefined, undefined, ctx);
    assert.equal(result.details.status, "resumed");
    const resumed = await launchedArgv("Resumed");
    assert.match(resumed, /ARG: --no-extensions/);
    assert.match(resumed, /ARG: .*powerline-footer\/index\.ts/, "resume must use the same presentation extensions");
  } finally {
    children.shutdown();
    if (started) { disposeSurfaces(); tmux("kill-server"); }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
