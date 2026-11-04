import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "../paths.ts";
import { shellEscape } from "../spawn/tmux.ts";

it("keeps the editors aligned when only main shows BG OFF, including after toggling it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-footer-alignment-"));
  const socket = join(dir, "socket");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const screen = (pane: string) => tmux("capture-pane", "-p", "-t", pane);
  const waitUntil = async (check: () => boolean, detail: () => string) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      assert.ok(Date.now() < deadline, detail());
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const borderRow = (pane: string) => screen(pane).split("\n")
    .reduce((last, line, index) => /^─{10}/u.test(line) ? index : last, -1);
  try {
    const main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "alignment", "-x", "180", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
    tmux("set-window-option", "-t", main, "remain-on-exit", "on");
    const child = tmux("split-window", "-d", "-h", "-t", main, "-P", "-F", "#{pane_id}", "sleep 600");
    const cli = process.env.PI_TEST_CLI ?? resolve(paths.root, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const base = `cd ${shellEscape(dir)} && PI_CODING_AGENT_DIR=${shellEscape(join(dir, "config"))} PI_SUBAGENT_NAME=Worker ${shellEscape(process.execPath)} ${shellEscape(cli)} --no-extensions --no-skills --no-prompt-templates --no-themes`;
    tmux("respawn-pane", "-k", "-t", main, `${base} -e ${shellEscape(join(paths.root, "index.ts"))} -e ${shellEscape(join(paths.siblingExtensions, "bash-guard/index.ts"))} --session ${shellEscape(join(dir, "main.jsonl"))}`);
    tmux("respawn-pane", "-k", "-t", child, `${base} -e ${shellEscape(paths.childEntry)} --session ${shellEscape(join(dir, "child.jsonl"))}`);
    await waitUntil(() => screen(main).includes(dir) && screen(child).includes(dir) &&
      screen(child).includes("Ctrl+Alt+A") && borderRow(main) >= 0 && borderRow(child) >= 0,
      () => `Main:\n${screen(main)}\nChild:\n${screen(child)}`);
    assert.equal(borderRow(main), borderRow(child), `baseline: editors align without a warning\nMain:\n${screen(main)}\nChild:\n${screen(child)}`);
    tmux("send-keys", "-t", main, "-l", "/bash-guard");
    tmux("send-keys", "-t", main, "Enter");
    await waitUntil(() => screen(main).includes("BG OFF"), () => screen(main));
    assert.doesNotMatch(screen(child), /BG OFF/, "children must not inherit an inapplicable warning");
    assert.equal(borderRow(main), borderRow(child), `editor bottom borders must align:\nMain:\n${screen(main)}\nChild:\n${screen(child)}`);
    const alignedRow = borderRow(main);
    tmux("send-keys", "-t", main, "-l", "/bash-guard");
    tmux("send-keys", "-t", main, "Enter");
    await waitUntil(() => screen(main).includes("bash-guard re-enabled."), () => screen(main));
    assert.equal(borderRow(main), alignedRow, "clearing a warning must not move the editor");
    assert.equal(borderRow(main), borderRow(child));
    for (const pane of [main, child]) tmux("send-keys", "-t", pane, "C-d");
    await waitUntil(() => [main, child].every((pane) =>
      tmux("display-message", "-p", "-t", pane, "#{pane_dead}") === "1"),
      () => "Pi did not finish session cleanup");
  } finally {
    try { tmux("kill-server"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
