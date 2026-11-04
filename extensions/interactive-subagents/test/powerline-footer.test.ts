import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "../paths.ts";
import { shellEscape } from "../spawn/tmux.ts";

it("renders a single aligned Powerline row in real Pi and updates model, effort, context and BG", { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-powerline-"));
  const socket = join(dir, "socket");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const screen = (pane: string) => tmux("capture-pane", "-p", "-t", pane);
  const waitUntil = async (check: () => boolean, detail: () => string) => {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      assert.ok(Date.now() < deadline, detail());
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const fixture = join(dir, "provider.ts");
  // A local-only model catalogue, not a fake footer. This test never submits an LLM prompt.
  writeFileSync(fixture, `export default function(pi) {
    pi.registerProvider("footer-smoke", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "test-only",
      models: [
        { id: "model-one", name: "One", contextWindow: 200000 },
        { id: "model-two", name: "Two", contextWindow: 400000 }
      ].map(model => ({ ...model, reasoning: true, input: ["text"], maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))
    });
    pi.registerCommand("footer-smoke-switch", { handler: async (_args, ctx) => {
      await pi.setModel(ctx.modelRegistry.find("footer-smoke", "model-two"));
      pi.setThinkingLevel("low");
    }});
  }`);
  const seed = (name: string) => {
    const file = join(dir, `${name}.jsonl`);
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entries: any[] = [{ type: "session", version: 3, id: name, timestamp, cwd: dir }];
    let parentId: string | null = null;
    for (const [index, [input, output]] of [[10000, 1000], [120000, 3000]].entries()) {
      const id = `message-${index}`;
      entries.push({ type: "message", id, parentId, timestamp, message: {
        role: "assistant", content: [{ type: "text", text: "Seeded footer usage." }],
        api: "openai-completions", provider: "footer-smoke", model: "model-one", stopReason: "stop", timestamp: 0,
        usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }});
      parentId = id;
    }
    writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    return file;
  };
  let started = false;
  try {
    const main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "footer", "-x", "180", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
    started = true;
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    tmux("set-window-option", "-t", main, "remain-on-exit", "on");
    const child = tmux("split-window", "-d", "-h", "-t", main, "-P", "-F", "#{pane_id}", "sleep 600");
    const cli = process.env.PI_TEST_CLI ?? resolve(paths.root, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const footer = join(paths.siblingExtensions, "powerline-footer", "index.ts");
    for (const [pane, name, extra] of [[main, "main", join(paths.siblingExtensions, "bash-guard", "index.ts")], [child, "child", paths.childEntry]]) {
      const command = `cd ${shellEscape(dir)} && PI_CODING_AGENT_DIR=${shellEscape(join(dir, "config"))} ${shellEscape(process.execPath)} ${shellEscape(cli)} --no-extensions --no-skills --no-prompt-templates --no-themes -e ${shellEscape(fixture)} -e ${shellEscape(footer)} -e ${shellEscape(extra)} --model footer-smoke/model-one:high --session ${shellEscape(seed(name))}`;
      tmux("respawn-pane", "-k", "-t", pane, command);
    }
    const footerLine = (pane: string) => screen(pane).split("\n").find(line => line.includes("↑130k") && line.includes("↓4.0k")) ?? "";
    const detail = () => `Main:\n${screen(main)}\nChild:\n${screen(child)}`;
    await waitUntil(() => footerLine(main).includes("BG ON") && footerLine(child).includes("model-one high"), detail);
    for (const pane of [main, child]) {
      assert.match(footerLine(pane), /▰{6}▱{4} 123k/);
      assert.doesNotMatch(footerLine(pane), /%|\/200k/);
      assert.match(tmux("capture-pane", "-e", "-p", "-t", pane), /\x1b\[.*48;(2|5);/);
    }
    assert.doesNotMatch(footerLine(child), /BG ON|BG OFF/);
    const borderRow = (pane: string) => screen(pane).split("\n").reduce((last, line, index) => /^─{10}/u.test(line) ? index : last, -1);
    const aligned = borderRow(main);
    assert.ok(aligned >= 0);
    assert.equal(aligned, borderRow(child));
    tmux("send-keys", "-t", main, "-l", "/bash-guard");
    tmux("send-keys", "-t", main, "Enter");
    await waitUntil(() => footerLine(main).includes("BG OFF"), detail);
    assert.equal(screen(main).split("\n").filter(line => line.includes("BG OFF")).length, 1, "BG OFF is integrated, not a separate status row");
    assert.equal(borderRow(main), aligned);
    assert.equal(borderRow(main), borderRow(child));
    tmux("send-keys", "-t", main, "-l", "/bash-guard");
    tmux("send-keys", "-t", main, "Enter");
    await waitUntil(() => footerLine(main).includes("BG ON"), detail);
    tmux("send-keys", "-t", main, "-l", "/footer-smoke-switch");
    tmux("send-keys", "-t", main, "Enter");
    await waitUntil(() => footerLine(main).includes("model-two low"), detail);
    assert.match(footerLine(main), /▰{3}▱{7} 123k/);
    assert.equal(borderRow(main), aligned);
  } finally {
    if (started) tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
});
