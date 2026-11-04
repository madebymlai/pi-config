/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes keep their tmux ids (e.g. `%12`) while moving between the parent's
 * right-hand slot and a detached parking session. Pane-local metadata lets
 * the standalone list and children navigate without parent-process state.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

/**
 * The one sentence shown whenever something needs tmux and it is not there.
 * Both the spawn refusal and send_message's transport failure quote it, so it
 * is written once rather than reassembled at each site.
 */
export function muxUnavailableMessage(): string {
  return `Subagents require tmux. ${muxSetupHint()}`;
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

let listCommand: string | undefined;
const deckHooks = ["pane-exited", "after-kill-pane"];
const hookIndex = 9271;
const idleCollapses = new Map<string, ReturnType<typeof setTimeout>>();

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}

interface Deck {
  parent: string;
  list: string;
  parking: string;
}

function paneOption(pane: string, key: string): string {
  return tmux("display-message", "-p", "-t", pane, `#{@pi-deck-${key}}`);
}

function deckFor(pane = process.env.TMUX_PANE): Deck | undefined {
  if (!pane) return;
  const parent = paneOption(pane, "parent");
  if (!parent) return;
  return { parent, list: paneOption(pane, "list"), parking: paneOption(pane, "parking") };
}

function markPane(pane: string, deck: Deck): void {
  for (const [key, value] of Object.entries(deck)) {
    tmux("set-option", "-p", "-t", pane, `@pi-deck-${key}`, value);
  }
}

/** Configure the standalone list command before the first child is created. */
export function configureSurfaceList(command: string): void {
  listCommand = command;
}

function localOption(scope: "p" | "w", target: string, option: string): string | null {
  return tmux("show-options", `-${scope}q`, "-t", target, option)
    ? execFileSync("tmux", ["show-options", `-${scope}qv`, "-t", target, option], { encoding: "utf8" }).replace(/\n$/, "")
    : null;
}

function ensureDeck(): Deck {
  requireTmux();
  const existing = deckFor();
  if (existing) return existing;
  const parent = process.env.TMUX_PANE!;
  const width = tmux("display-message", "-p", "-t", parent, "#{pane_width}");
  const height = tmux("display-message", "-p", "-t", parent, "#{pane_height}");
  const parking = `pi-deck-${process.pid}-${parent.slice(1)}`;
  const list = tmux("new-session", "-d", "-s", parking, "-x", String(Math.floor(Number(width) / 2)), "-y", height, "-P", "-F", "#{pane_id}");
  const deck = { parent, list, parking };
  // Keep the detached session alive when its list pane moves into the main window.
  tmux("new-window", "-d", "-t", `${parking}:`, "sleep 2147483647");
  markPane(parent, deck);
  markPane(list, deck);
  const headers = {
    "pane-border-status": "top",
    "pane-border-style": "fg=colour238",
    "pane-active-border-style": "fg=colour238",
    "pane-border-indicators": "off",
    "pane-border-lines": "single",
    "pane-border-format": "#{?pane_active,#[fg=colour232]#[bg=colour75]#[bold] #{@pi-label} #[default],#[fg=colour244] #{@pi-label} #[default]}",
  };
  // Pane metadata survives calls from the list or a child process.
  const window = tmux("display-message", "-p", "-t", parent, "#{window_id}");
  const previous = {
    window,
    options: Object.fromEntries(Object.keys(headers).map(option => [option, localOption("w", window, option)])),
    label: localOption("p", parent, "@pi-label"),
  };
  tmux("set-option", "-p", "-t", parent, "@pi-deck-headers", JSON.stringify(previous));
  tmux("set-option", "-p", "-t", parent, "@pi-label", "Main");
  tmux("set-option", "-p", "-t", list, "@pi-label", "Agents list");
  for (const [option, value] of Object.entries(headers)) tmux("set-option", "-w", "-t", window, option, value);
  tmux("join-pane", "-d", "-h", "-s", list, "-t", parent);
  tmux("select-layout", "-t", parent, "even-horizontal");
  // Scoped, additive hooks also recover a selected pane killed outside this API.
  const restore = `if-shell -F '#{==:#{window_panes},1}' 'join-pane -d -h -s ${list} -t ${parent} ; select-layout -t ${parent} even-horizontal'`;
  for (const hook of deckHooks) tmux("set-hook", "-w", "-t", parent, `${hook}[${hookIndex}]`, restore);
  if (listCommand) tmux("respawn-pane", "-k", "-t", list, listCommand);
  return deck;
}

/** Show the first child directly, introduce the list at two, and keep main focused. */
export function createSurface(name: string, role?: string): string {
  const deck = ensureDeck();
  const pane = tmux("new-window", "-d", "-t", `${deck.parking}:`, "-n", name, "-P", "-F", "#{pane_id}");
  markPane(pane, deck);
  tmux("set-option", "-p", "-t", pane, "@pi-label", role ? `${name} (${role})` : name);
  const size = tmux("display-message", "-p", "-t", deck.parent, "#{pane_width} #{pane_height}").split(" ");
  tmux("resize-window", "-t", pane, "-x", size[0], "-y", size[1]);
  reconcileDeck(deck, "create");
  return pane;
}

function ownedPanes(deck: Deck, all = false): string[] {
  return tmux("list-panes", ...(all ? ["-a"] : ["-t", deck.parent]), "-F", "#{pane_id} #{@pi-deck-parent}")
    .split("\n").map(row => row.split(" "))
    .filter(([pane, parent]) => parent === deck.parent && pane !== deck.parent)
    .map(([pane]) => pane);
}

function cancelIdleCollapse(deck: Deck): void {
  clearTimeout(idleCollapses.get(deck.parent));
  idleCollapses.delete(deck.parent);
}

function scheduleIdleCollapse(deck: Deck): void {
  if (idleCollapses.has(deck.parent)) return;
  const timer = setTimeout(() => {
    idleCollapses.delete(deck.parent);
    // A reload or cross-process cleanup may have replaced this deck already.
    if (deckFor(deck.parent)?.list !== deck.list) return;
    if (ownedPanes(deck, true).some(pane => pane !== deck.list)) return;
    const visible = ownedPanes(deck)[0];
    if (visible) tmux("break-pane", "-d", "-s", visible, "-t", `${deck.parking}:`);
  }, 30_000);
  timer.unref();
  idleCollapses.set(deck.parent, timer);
}

/** All entry points share the same zero / one / many policy. */
function reconcileDeck(deck: Deck, reason: "create" | "close" | "browse", focus = reason === "browse"): void {
  const children = ownedPanes(deck, true).filter(pane => pane !== deck.list);
  const visible = ownedPanes(deck)[0];
  if (children.length === 0) {
    tmux("set-option", "-pu", "-t", deck.parent, "@pi-deck-selected");
    if (reason === "close" && visible) scheduleIdleCollapse(deck);
    if (focus) tmux("select-pane", "-t", deck.parent);
    return;
  }
  cancelIdleCollapse(deck);
  const selected = paneOption(deck.parent, "selected");
  if (selected === deck.list) {
    reveal(deck, deck.list, focus);
  } else if (children.length === 1) {
    reveal(deck, children[0], focus);
  } else if (!visible ||
    (reason === "create" && children.length === 2 && selected !== visible)) {
    reveal(deck, deck.list, focus);
  } else if (focus) {
    tmux("select-pane", "-t", visible);
  }
}

function reveal(deck: Deck, pane: string, focus = true): void {
  const visible = ownedPanes(deck)[0];
  if (visible !== pane) {
    if (visible) tmux("swap-pane", "-d", "-s", pane, "-t", visible);
    else tmux("join-pane", "-d", "-h", "-s", pane, "-t", deck.parent);
  }
  tmux("select-layout", "-t", deck.parent, "even-horizontal");
  if (focus) tmux("select-pane", "-t", pane);
}

/** Select an owned child; callable in the parent, list, or another child. */
export function showSurface(surface: string): void {
  requireTmux();
  const deck = deckFor();
  if (!deck || surface === deck.parent || paneOption(surface, "parent") !== deck.parent) {
    throw new Error("Surface does not belong to this pane deck");
  }
  tmux("set-option", "-p", "-t", deck.parent, "@pi-deck-selected", surface);
  reveal(deck, surface);
}

export function showSurfaceList(): void {
  requireTmux();
  const deck = deckFor();
  if (deck) {
    tmux("set-option", "-p", "-t", deck.parent, "@pi-deck-selected", deck.list);
    reconcileDeck(deck, "browse");
  }
}

export function returnToSurfaceList(): void {
  showSurfaceList();
}

/** Focus main without changing what is displayed on the right. */
export function focusSurfaceParent(): void {
  requireTmux();
  const deck = deckFor();
  if (deck) tmux("select-pane", "-t", deck.parent);
}

/** Remove only this deck's panes, metadata, and window hooks. */
export function disposeSurfaces(): void {
  if (!isTmuxAvailable()) return;
  const deck = deckFor();
  if (!deck) return;
  cancelIdleCollapse(deck);
  for (const hook of deckHooks) tmux("set-hook", "-wu", "-t", deck.parent, `${hook}[${hookIndex}]`);
  const owned = tmux("list-panes", "-a", "-F", "#{pane_id} #{@pi-deck-parent}").split("\n");
  for (const row of owned) {
    const [pane, parent] = row.split(" ");
    if (parent === deck.parent && pane !== deck.parent) tmux("kill-pane", "-t", pane);
  }
  tmux("kill-session", "-t", deck.parking);
  const saved = paneOption(deck.parent, "headers");
  if (saved) {
    const previous: { window: string; options: Record<string, string | null>; label: string | null } = JSON.parse(saved);
    for (const [option, value] of Object.entries(previous.options)) {
      if (value === null) tmux("set-option", "-wu", "-t", previous.window, option);
      else tmux("set-option", "-w", "-t", previous.window, option, value);
    }
    if (previous.label === null) tmux("set-option", "-pu", "-t", deck.parent, "@pi-label");
    else tmux("set-option", "-p", "-t", deck.parent, "@pi-label", previous.label);
  }
  for (const key of ["parent", "list", "parking", "headers", "selected"]) tmux("set-option", "-pu", "-t", deck.parent, `@pi-deck-${key}`);
}

// ── Surface primitives ──

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter. Any pane mode (copy mode after a scroll) is
 * cancelled first; otherwise the text is read as mode key bindings instead.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["copy-mode", "-q", "-t", surface], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  const exists = surfaceExists(surface);
  // The watcher also calls this after a process exits or a pane is killed externally.
  const deck = exists ? deckFor(surface) : deckFor();
  const focused = exists && tmux("display-message", "-p", "-t", surface, "#{pane_active}") === "1"
    && deck !== undefined && ownedPanes(deck).includes(surface);
  if (exists) tmux("kill-pane", "-t", surface);
  if (deck && surface !== deck.list && surface !== deck.parent) reconcileDeck(deck, "close", focused);
}

/**
 * Whether the pane is still there. A pane closed from outside (the user, a
 * kill-pane, a crash) leaves neither a sidecar nor a sentinel behind.
 */
function surfaceExists(surface: string): boolean {
  // display-message succeeds with empty output for a missing pane, so the
  // answer is in what it prints, not in its exit status.
  try {
    const paneId = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return paneId.trim() === surface;
  } catch {
    return false;
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "closed";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * child/index.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: messaging the parent does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.message` file (see deliverPendingMessage).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: the child's own account of how it ended, written on every
    // exit it is alive to report. Durable, so it survives the pane.
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Slow path: crash detection only. The echo lives in the launch script
    // rather than in the child, so it still fires when the child never reached
    // agent_end at all: a bad model, a missing key, an extension that failed to
    // load. Nothing else can see those, which is why it stays.
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
      if (isTmuxAvailable() && !surfaceExists(surface)) {
        return { reason: "closed", exitCode: 1 };
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
