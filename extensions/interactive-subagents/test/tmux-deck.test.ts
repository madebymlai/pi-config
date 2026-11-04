import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as surfaces from "../spawn/tmux.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-deck-test-"));
const socket = join(dir, "socket");
const oldTmux = process.env.TMUX;
const oldPane = process.env.TMUX_PANE;
const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
let main: string;
const panes = () => tmux("list-panes", "-t", main, "-F", "#{pane_id}").split("\n");
const width = () => Number(tmux("display-message", "-p", "-t", main, "#{pane_width}"));
const focused = (pane: string) => tmux("display-message", "-p", "-t", pane, "#{pane_active}") === "1";
const crossProcess = (pane: string, expression: string) => execFileSync(process.execPath, ["--input-type=module", "-e", `import * as s from ${JSON.stringify(new URL("../spawn/tmux.ts", import.meta.url).href)}; ${expression}`], { env: { ...process.env, TMUX_PANE: pane } });

before(() => {
  main = tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}", "sleep 600");
  tmux("set-option", "-g", "default-shell", "/bin/sh");
  process.env.TMUX = `${socket},0,0`;
  process.env.TMUX_PANE = main;
});
after(() => {
  tmux("kill-server");
  if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
  rmSync(dir, { recursive: true, force: true });
});

it("keeps only main and list visible with arbitrarily many running children", () => {
  for (let i = 0; i < 4; i++) surfaces.createSurface(`child-${i}`);
  assert.equal(panes().length, 2);
  assert.ok(Math.abs(width() - 80) <= 1);
  assert.equal(tmux("display-message", "-p", "-t", main, "#{pane_active}"), "1");
});

it("selects children across processes without replacing their processes or pane IDs", () => {
  const list = panes().find(p => p !== main)!;
  const a = surfaces.createSurface("a");
  const b = surfaces.createSurface("b");
  const pid = tmux("display-message", "-p", "-t", a, "#{pane_pid}");
  crossProcess(list, `s.showSurface(${JSON.stringify(a)})`);
  assert.deepEqual(panes(), [main, a]);
  assert.ok(focused(a));
  surfaces.showSurface(b);
  assert.deepEqual(panes(), [main, b]);
  assert.equal(tmux("display-message", "-p", "-t", a, "#{pane_pid}"), pid);
  crossProcess(b, "s.returnToSurfaceList()");
  assert.deepEqual(panes(), [main, list]);
  assert.ok(focused(list));
  crossProcess(list, "s.focusSurfaceParent()");
  assert.ok(focused(main));
  assert.deepEqual(panes(), [main, list]);
});

it("keeps halves on resize and sizes parked children near the right pane", () => {
  tmux("resize-window", "-t", main, "-x", "200", "-y", "50");
  assert.ok(Math.abs(width() - 100) <= 1);
  const child = surfaces.createSurface("sized");
  const childWidth = Number(tmux("display-message", "-p", "-t", child, "#{pane_width}"));
  assert.ok(Math.abs(childWidth - 100) <= 1, `parked child width ${childWidth}`);
});

it("restores the list when closing the selected child", () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("closing");
  surfaces.showSurface(child);
  surfaces.closeSurface(child);
  assert.deepEqual(panes(), [main, list]);
  assert.ok(Math.abs(width() - 100) <= 1);
});

it("keeps main focused when the visible child closes in the background", () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("background-close");
  surfaces.showSurface(child);
  surfaces.focusSurfaceParent();
  surfaces.closeSurface(child);
  assert.deepEqual(panes(), [main, list]);
  assert.ok(focused(main));
});

it("gives the list focus when the focused child closes", () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("focused-close");
  surfaces.showSurface(child);
  surfaces.closeSurface(child);
  assert.deepEqual(panes(), [main, list]);
  assert.ok(focused(list));
});

it("restores list after an external kill", () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("external-close");
  surfaces.showSurface(child);
  tmux("kill-pane", "-t", child);
  assert.deepEqual(panes(), [main, list]);
});

it("restores list when a selected process exits naturally", async () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("natural-exit");
  surfaces.showSurface(child);
  tmux("respawn-pane", "-k", "-t", child, "true");
  for (let i = 0; i < 100 && !panes().includes(list); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(panes(), [main, list]);
});

it("cleans up all owned panes and parking sessions idempotently", () => {
  surfaces.showSurface(surfaces.createSurface("cleanup-selected"));
  surfaces.disposeSurfaces();
  surfaces.disposeSurfaces();
  assert.deepEqual(panes(), [main]);
  assert.equal(tmux("list-sessions", "-F", "#{session_name}"), "test");
  assert.equal(tmux("list-panes", "-a", "-F", "#{pane_id}"), main);
});

it("makes cleanup a no-op outside tmux", () => {
  const saved = process.env.TMUX;
  delete process.env.TMUX;
  try {
    assert.doesNotThrow(() => surfaces.disposeSurfaces());
  } finally {
    process.env.TMUX = saved;
  }
});

it("starts the list without relying on an interactive shell reading typed input", async () => {
  const result = join(dir, "blocked-shell-list-ready");
  // Model a shell startup that has not reached its input loop.
  tmux("set-option", "-g", "default-command", "sleep 600");
  surfaces.configureSurfaceList(`tmux display-message -p -t "$TMUX_PANE" '#{@pi-deck-parent}' > ${surfaces.shellEscape(result)}; sleep 600`);
  try {
    surfaces.createSurface("blocked-shell");
    for (let i = 0; i < 100 && !existsSync(result); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(result, "utf8").trim(), main);
  } finally {
    surfaces.disposeSurfaces();
    tmux("set-option", "-gu", "default-command");
  }
});

it("publishes navigation metadata before starting the configured list command", async () => {
  const result = join(dir, "list-ready");
  surfaces.configureSurfaceList(`tmux display-message -p -t "$TMUX_PANE" '#{@pi-deck-parent}' > ${surfaces.shellEscape(result)}`);
  assert.deepEqual(panes(), [main], "configuration is lazy");
  surfaces.createSurface("configured");
  for (let i = 0; i < 200 && !existsSync(result); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(readFileSync(result, "utf8").trim(), main);
  surfaces.disposeSurfaces();
});
