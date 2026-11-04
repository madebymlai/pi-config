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

it("opens the list with one agent from either pane and leaves it visible when focusing Main", () => {
  try {
    const agent = surfaces.createSurface("Only", "worker");
    assert.deepEqual(panes(), [main, agent], "one agent is still the automatic initial view");
    surfaces.showSurfaceList();
    const list = panes().find(pane => pane !== main)!;
    assert.notEqual(list, agent, "explicit browsing must open the list, not refocus the sole agent");
    assert.match(tmux("display-message", "-p", "-t", list, "#{E:pane-border-format}"), /Agents list/);
    assert.ok(focused(list));
    crossProcess(list, "s.focusSurfaceParent()");
    assert.deepEqual(panes(), [main, list], "Esc changes focus, not the chosen view");
    assert.ok(focused(main));
    crossProcess(list, `s.showSurface(${JSON.stringify(agent)})`);
    assert.deepEqual(panes(), [main, agent]);
    crossProcess(agent, "s.returnToSurfaceList()");
    assert.deepEqual(panes(), [main, list], "navigation from the sole child also opens the list");
    assert.ok(focused(list));
  } finally {
    surfaces.disposeSurfaces();
  }
});

it("keeps an explicitly chosen list through count changes until an agent is opened", () => {
  try {
    const a = surfaces.createSurface("Alpha", "worker");
    const b = surfaces.createSurface("Beta", "scout");
    const list = panes().find(pane => pane !== main)!;
    crossProcess(a, "s.returnToSurfaceList()");
    crossProcess(list, "s.focusSurfaceParent()");
    const c = surfaces.createSurface("Gamma", "reviewer");
    assert.deepEqual(panes(), [main, list], "two to three preserves the chosen list");
    surfaces.closeSurface(c);
    assert.deepEqual(panes(), [main, list], "three to two preserves the chosen list");
    surfaces.closeSurface(b);
    assert.deepEqual(panes(), [main, list], "two to one preserves the chosen list");
    assert.ok(focused(main), "background count changes do not steal focus from Main");
    crossProcess(list, `s.showSurface(${JSON.stringify(a)})`);
    assert.deepEqual(panes(), [main, a], "opening an agent replaces the list choice");
    surfaces.createSurface("Delta", "scout");
    assert.deepEqual(panes(), [main, a], "the chosen agent is preserved instead of the old list choice");
  } finally {
    surfaces.disposeSurfaces();
  }
});

it("shows the sole agent at one, the list from two, and collapses after 30 idle seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const a = surfaces.createSurface("Alpha", "worker");
    assert.deepEqual(panes(), [main, a], "the first agent is shown directly");
    assert.ok(focused(main), "creating the first agent does not steal focus");
    surfaces.showSurfaceList();
    const list = panes().find(pane => pane !== main)!;
    assert.notEqual(list, a, "explicit browsing opens the list even with one agent");
    assert.ok(focused(list));
    surfaces.focusSurfaceParent();
    const b = surfaces.createSurface("Beta", "scout");
    assert.deepEqual(panes(), [main, list], "the second agent keeps the chosen list");
    assert.ok(focused(main));
    surfaces.showSurface(a);
    const c = surfaces.createSurface("Gamma", "reviewer");
    assert.deepEqual(panes(), [main, a], "additional agents preserve the selected view");
    surfaces.closeSurface(c);
    assert.deepEqual(panes(), [main, a], "three to two preserves a selected agent");
    surfaces.showSurfaceList();
    surfaces.closeSurface(b);
    assert.deepEqual(panes(), [main, list], "two to one preserves the explicitly chosen list");
    assert.ok(focused(list), "the chosen list keeps focus");
    surfaces.closeSurface(a);
    assert.deepEqual(panes(), [main, list], "the empty list holds the right slot during the grace period");
    t.mock.timers.tick(29_000);
    assert.deepEqual(panes(), [main, list], "Main does not expand before the grace period ends");
    const next = surfaces.createSurface("Again", "worker");
    assert.deepEqual(panes(), [main, next], "a new agent replaces the empty list directly");
    t.mock.timers.tick(1_000);
    assert.deepEqual(panes(), [main, next], "the previous collapse was cancelled");
    surfaces.closeSurface(next);
    t.mock.timers.tick(29_999);
    assert.deepEqual(panes(), [main, list], "each idle period gets its own full delay");
    t.mock.timers.tick(1);
    assert.deepEqual(panes(), [main], "the last exit eventually removes the right pane");
    assert.equal(width(), 160, "Main gets the full window width back");
    surfaces.showSurfaceList();
    assert.deepEqual(panes(), [main], "browsing zero agents does not reopen the list");
    const later = surfaces.createSurface("Later", "worker");
    assert.deepEqual(panes(), [main, later], "a later first agent is shown directly again");
  } finally {
    surfaces.disposeSurfaces();
  }
});

it("preserves an explicitly opened agent when another agent starts", () => {
  try {
    const a = surfaces.createSurface("chosen", "worker");
    surfaces.showSurface(a);
    surfaces.focusSurfaceParent();
    const b = surfaces.createSurface("second", "scout");
    assert.deepEqual(panes(), [main, a], "an explicit selection survives a new arrival");
    surfaces.showSurfaceList();
    const list = panes().find(p => p !== main)!;
    surfaces.closeSurface(b);
    surfaces.createSurface("replacement", "scout");
    assert.deepEqual(panes(), [main, list], "choosing the list clears the previous selection");
  } finally {
    surfaces.disposeSurfaces();
  }
});

it("reconciles already-closed panes when the completion watcher cleans them up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const a = surfaces.createSurface("survivor", "worker");
    const b = surfaces.createSurface("external", "scout");
    tmux("kill-pane", "-t", b);
    surfaces.closeSurface(b);
    assert.deepEqual(panes(), [main, a], "an external exit still reveals the sole survivor");
    tmux("kill-pane", "-t", a);
    surfaces.closeSurface(a);
    assert.equal(panes().length, 2, "an external last exit gets the same grace period");
    t.mock.timers.tick(20_000);
    surfaces.closeSurface(a);
    t.mock.timers.tick(10_000);
    assert.deepEqual(panes(), [main], "duplicate cleanup must not restart the idle period");
  } finally {
    surfaces.disposeSurfaces();
  }
});

it("keeps only main and list visible with arbitrarily many running children", () => {
  for (let i = 0; i < 4; i++) surfaces.createSurface(`child-${i}`);
  assert.equal(panes().length, 2);
  assert.ok(Math.abs(width() - 80) <= 1);
  assert.equal(tmux("display-message", "-p", "-t", main, "#{pane_active}"), "1");
});

it("labels panes by identity and highlights only the focused header through swaps", () => {
  const list = panes().find(p => p !== main)!;
  const child = surfaces.createSurface("Ada", "reviewer");
  const label = (pane: string) => tmux("show-options", "-pqv", "-t", pane, "@pi-label");
  const header = (pane: string) => tmux("display-message", "-p", "-t", pane, "#{E:pane-border-format}");
  assert.equal(label(main), "Main");
  assert.equal(label(list), "Agents list");
  assert.equal(label(child), "Ada (reviewer)");
  assert.equal(tmux("show-options", "-wv", "-t", main, "pane-border-status"), "top");
  for (const option of ["pane-border-style", "pane-active-border-style"]) {
    assert.equal(tmux("show-options", "-wv", "-t", main, option), "fg=colour238");
  }
  assert.equal(tmux("show-options", "-wv", "-t", main, "pane-border-indicators"), "off");
  assert.equal(tmux("show-options", "-wv", "-t", main, "pane-border-lines"), "single");
  assert.equal(header(main), "#[fg=colour232]#[bg=colour75]#[bold] Main #[default]");
  assert.equal(header(list), "#[fg=colour244] Agents list #[default]");
  surfaces.showSurface(child);
  assert.equal(header(child), "#[fg=colour232]#[bg=colour75]#[bold] Ada (reviewer) #[default]");
  assert.equal(header(main), "#[fg=colour244] Main #[default]");
  surfaces.showSurfaceList();
  assert.equal(label(child), "Ada (reviewer)");
  assert.equal(label(list), "Agents list");
  surfaces.focusSurfaceParent();
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

it("restores local header settings and inherited settings even when disposed by another process", () => {
  const options = {
    "pane-border-status": "bottom",
    "pane-border-style": "fg=red",
    "pane-active-border-style": "fg=green,bold",
    "pane-border-indicators": "colour",
    "pane-border-lines": "double",
    "pane-border-format": "",
  };
  const other = tmux("new-window", "-d", "-t", "test:", "-P", "-F", "#{pane_id}", "sleep 600");
  for (const local of [true, false]) {
    for (const [option, value] of Object.entries(options)) {
      tmux("set-option", "-gw", option, value);
      if (local) tmux("set-option", "-w", "-t", main, option, value);
      else tmux("set-option", "-wu", "-t", main, option);
    }
    tmux("set-option", "-w", "-t", main, "@pi-label", "Inherited main");
    if (local) tmux("set-option", "-p", "-t", main, "@pi-label", " Original main ");
    else tmux("set-option", "-pu", "-t", main, "@pi-label");
    const child = surfaces.createSurface("restore", "scout");
    for (const [option, value] of Object.entries(options)) {
      assert.equal(tmux("show-options", "-wAv", "-t", other, option), value, "other windows are untouched");
    }
    // Changing the inherited value during use must not create a stale local override.
    tmux("set-option", "-gw", "pane-border-status", "off");
    crossProcess(child, "s.disposeSurfaces()");
    for (const [option, value] of Object.entries(options)) {
      assert.equal(tmux("show-options", "-wAv", "-t", main, option), !local && option === "pane-border-status" ? "off" : value);
      if (!local) assert.equal(tmux("show-options", "-wq", "-t", main, option), "");
    }
    assert.equal(execFileSync("tmux", ["-S", socket, "show-options", "-pAv", "-t", main, "@pi-label"], { encoding: "utf8" }), local ? " Original main \n" : "Inherited main\n");
    if (!local) assert.equal(tmux("show-options", "-pq", "-t", main, "@pi-label"), "");
  }
  tmux("kill-pane", "-t", other);
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
