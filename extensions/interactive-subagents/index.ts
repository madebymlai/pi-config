import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { renderSubagentWidget } from "./render/widget.ts";
import { describeRefusal, refuseSpawn } from "./spawn/guard.ts";
import {
  describeResult,
  fallbackSummary,
  formatElapsed,
  stripResultPreamble,
  usageSegments,
  type UsageSeverity,
} from "./render/result.ts";
import { getAgentConfigDir, paths } from "./paths.ts";
import { computeToolAllowlist, promptArgs, sandboxArgs, slugify } from "./spawn/sandbox.ts";
import {
  listAgents,
  resolveAgentLaunch,
  RESUME_LAUNCH,
  type AgentDefaults,
} from "./spawn/agents.ts";
import {
  isMuxAvailable,
  muxUnavailableMessage,
  createSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
} from "./spawn/tmux.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  summarizeSessionStats,
  type SessionStats,
} from "./observe/transcript.ts";
import { seedSubagentSessionFile } from "./spawn/seed-session.ts";
import { readSubagentLoadout, writeSubagentLoadout, type SubagentLoadout } from "./store/loadout.ts";
import { readNameRegistry, registerName, resolveNameInRegistry } from "./store/name-registry.ts";
// Only the aggregate formatting and config are still index.ts's business;
// everything about an individual subagent's status now sits behind liveness.ts.
import {
  capStatusLines,
  formatStatusAggregate,
  formatTransitionLine,
  loadStatusConfig,
} from "./render/status.ts";
import { createLiveness, getSubagentActivityFile, type SubagentLiveness } from "./observe/liveness.ts";
import {
  registerSendMessage,
  type Delivery,
  type MessagingContext,
  type Transport,
} from "./protocol/messaging.ts";

/** Absolute path to this extension's directory. https://github.com/nodejs/node/issues/37845 */
/** How a usage segment's severity is painted. The theme is the caller's, so the mapping is too. */
const USAGE_TONE = {
  normal: "dim",
  warning: "warning",
  critical: "error",
} as const satisfies Record<UsageSeverity, string>;

/** Injected into the system prompt, so it stays short. */
const SPAWN_SNIPPET =
  "Spawn a sub-agent in its own pane. Fire and forget: its result arrives later as a steer " +
  "message. Never poll for it and never invent one.";

/** Shown when choosing the tool. Says what it does, then how results arrive. */
const SPAWN_GUIDANCE =
  "Spawn a sub-agent in its own terminal pane to carry out one task independently. " +
  "Returns immediately with an acknowledgement, never with a result. " +
  "When the sub-agent finishes, the harness delivers its result as a steer message that wakes " +
  "you and starts a new turn. You do nothing to receive it. " +
  "Never poll, sleep, tail logs, read session files, or call another tool to check status: that " +
  "work is always wasted. Never state a result you have not been given. " +
  "After spawning, end your turn or start other independent work, including further sub-agents " +
  "in parallel.";

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn, for example 'worker', 'scout' or 'researcher'. This loads that " +
      "agent's fixed profile: its model, tool loadout and system prompt. Must be an agent that " +
      "subagents_list reports.",
  }),
  task: Type.String({
    description:
      "What the sub-agent must accomplish. It starts with none of this conversation unless its " +
      "agent is set to inherit it, so give the goal, the files or areas involved, and what " +
      "finished looks like. It can message you for anything missing, which pauses it until you " +
      "reply.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Cosmetic label for the sub-agent's pane and widget row. Defaults to the agent name. " +
        "It selects nothing: use `agent` to choose which agent runs. It does become the handle " +
        "send_message addresses this sub-agent by.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Run this one spawn on a different model than the agent's profile specifies. Reach for " +
        "it when a task is unusually hard or unusually routine.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/** The same refusal as the spawn guard's, shaped for send_message's outcomes. */
function muxUnavailableDelivery(): Delivery {
  return { status: "transport-failed", reason: muxUnavailableMessage() };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/**
 * The artifact dir of the session doing the messaging: where its name registry
 * lives. Null when this session has no session file, and so has never
 * registered a subagent it could resume.
 */
function parentArtifactDirOf(ctx: MessagingContext) {
  try {
    return getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  } catch {
    return null;
  }
}

const statusConfig = loadStatusConfig();

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via send_message. */
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** The generated shell script, kept so a launch can be inspected after the fact. */
  launchScriptFile: string;
  /** Aborts the watcher; the tool call's own signal is long gone by then. */
  abortController: AbortController;
  /** How it is doing. The activity file and the status state live behind this. */
  liveness: SubagentLiveness;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `child/index.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (child/index.ts reads it; if absent it assumes zero.)

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver subagent messages from the watcher. */
let latestPi: ExtensionAPI | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          const now = Date.now();
          const rows = Array.from(runningSubagents.values()).map((running) => ({
            name: running.name,
            agent: running.agent,
            elapsedMs: now - running.startTime,
            snapshot: running.liveness.snapshot(now),
          }));
          return renderSubagentWidget(rows, width, { showStatus: statusConfig.enabled });
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `send_message({ to })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via tmux: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

/**
 * Steer one already-resolved running subagent, reporting the outcome as a
 * Delivery. A failed send deliberately leaves the status state untouched: the
 * subagent never saw the message, so it must not be shown as interrupted.
 */
function steerRunning(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): Delivery {
  const now = Date.now();
  running.liveness.observe(now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) return { status: "transport-failed", reason: steer.error };

  running.liveness.interrupted(now);
  updateWidget();

  return { status: "steered", name: running.name };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      const { kindChanged, transition, snapshot } = running.liveness.tick(now);
      if (kindChanged) shouldRefreshWidget = true;
      // liveness reports the transition; turning it into a sentence is this
      // layer's job, which is what keeps observe/ from importing render/.
      if (transition) transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
  getShellReadyDelayMs,
  uniqueRunningName,
  reservedNames,
  steerRunning,
  createChildTransports,
  runningSubagents,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  pi: ExtensionAPI,
  params: Static<typeof SubagentParams> & { name: string },
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd">,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const launchBehavior = resolveAgentLaunch(params.agent);
  const agentDefs = launchBehavior.defs;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = launchBehavior.interactive;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = launchBehavior.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop. Your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = launchBehavior.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  // An agent with a non-empty subagent_agents list is granted the spawning
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = paths.childEntry;
  parts.push("-e", shellEscape(subagentDonePath));

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Default-deny model: when an agent restricts its tools (or is granted the
  // spawning toolset), we disable global extension discovery and re-enable only
  // the extensions backing the whitelisted tools. Bare/fork spawns with no tool
  // restriction keep their full default toolset and all global extensions.
  const toolAllowlist = computeToolAllowlist(effectiveTools);

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `send_message({ to })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    autoExit: launchBehavior.autoExit,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Model, identity, and the default-deny tool/extension restriction. Resume
  // splices in the very same args, so the two paths can't drift.
  parts.push(...sandboxArgs(loadout, { artifactDir, name: params.name }));

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (launchBehavior.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = slugify(params.name);
    const artifactName = `context/${safeName}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of promptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  return runSubagent(pi, {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    sessionFile: subagentSessionFile,
    artifactDir,
    activityFile,
    interactive: effectiveInteractive,
    startTime,
    command: cdPrefix + envPrefix + parts.join(" "),
    kind: "launch",
    fromEntry: 0,
  });
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
/**
 * Detect a parent-directed message from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.message` file and its own watcher, so messages from several
 * subagents arrive independently. The file is deleted after delivery so it
 * fires once per message (a subagent may message again later).
 */
function deliverPendingMessage(running: RunningSubagent): void {
  const messageFile = `${running.sessionFile}.message`;
  let payload: any = null;
  try {
    if (!existsSync(messageFile)) return;
    payload = JSON.parse(readFileSync(messageFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(messageFile);
  } catch {}
  if (!payload?.message) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with send_message({ to: "${name}", message: "…" }). The same name works whether it is still running or has since exited, and it stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_message",
      content: `Sub-agent "${name}" messaged you (${formatElapsed(elapsed)}):\n\n${payload.message}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        message: payload.message,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * Everything that happens once a subagent's command line is decided: put it in
 * the surface, register it for the widget, and supervise it to completion.
 *
 * Spawning and resuming differ only in the command they build and where their
 * transcript starts. Before this existed the sequence below was written twice
 * and had already drifted — the spawn path exported a PI_SUBAGENT_SURFACE the
 * resume path did not, and nothing read it either way.
 */
interface SubagentRun {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  sessionFile: string;
  artifactDir: string;
  activityFile: string;
  interactive: boolean;
  startTime: number;
  /** The pi invocation. The completion echo the watcher looks for is added here. */
  command: string;
  /** Names the generated script and its preamble, and nothing else. */
  kind: "launch" | "resume";
  /** Passed to watchSubagent: a resumed run reports only the turns it added. */
  fromEntry: number;
}

function runSubagent(pi: ExtensionAPI, run: SubagentRun): RunningSubagent {
  const scriptSuffix = run.kind === "resume" ? `resume-${Date.now()}` : run.id;
  const launchScriptFile = join(
    run.artifactDir,
    "subagent-scripts",
    `${slugify(run.name, "subagent")}-${scriptSuffix}.sh`,
  );

  sendLongCommand(run.surface, `${run.command}; echo '__SUBAGENT_DONE_'$?'__'`, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent ${run.kind} script for ${run.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${run.sessionFile}`,
      `# Surface: ${run.surface}`,
    ].join("\n"),
  });

  // A dedicated controller: the tool call's own signal completes when it
  // returns, which is long before the subagent does.
  const watcherAbort = new AbortController();

  const running: RunningSubagent = {
    id: run.id,
    name: run.name,
    task: run.task,
    agent: run.agent,
    surface: run.surface,
    startTime: run.startTime,
    sessionFile: run.sessionFile,
    launchScriptFile,
    abortController: watcherAbort,
    liveness: createLiveness({
      id: run.id,
      activityFile: run.activityFile,
      startTimeMs: run.startTime,
      interactive: run.interactive,
    }),
  };
  runningSubagents.set(run.id, running);

  // The widget and the status supervisor are idle until something is running.
  startWidgetRefresh();
  startStatusRefresh(pi);

  watchSubagent(running, watcherAbort.signal, run.fromEntry)
    .then((result) => {
      updateWidget(); // reflect removal from the map immediately
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: describeResult(result, running.name),
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            ...(result.stats ? { stats: result.stats } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      updateWidget();
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

  return running;
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  /**
   * Session entry to summarize from. A resumed run reports only the turns it
   * added, so its caller passes the transcript length recorded before resuming;
   * a fresh spawn summarizes the whole file.
   */
  fromEntry = 0,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      onTick() {
        running.liveness.observe(Date.now());
        deliverPendingMessage(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // The subagent's own last word, or a stand-in describing how it ended.
    const summary =
      (existsSync(sessionFile)
        ? findLastAssistantMessage(getNewEntries(sessionFile, fromEntry))
        : null) ?? fallbackSummary(result);

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

/**
 * The two ways to reach a subagent of this session, in precedence order.
 *
 * Steering a live pane comes first: a name that matches a running subagent must
 * never be resumed, because two processes appending to one .jsonl corrupts it.
 * Resuming a finished session comes second, and passes (returns null) on a name
 * it does not know so the router can explain the miss across every transport
 * rather than only this one.
 *
 * `deps` exists so the whole path above tmux can be exercised without a tmux
 * server, the way the retired subagent engine took its spawn adapter.
 */
function createChildTransports(
  pi: ExtensionAPI,
  deps: {
    send?: (surface: string, command: string) => void;
    muxAvailable?: () => boolean;
  } = {},
) {
  const send = deps.send ?? sendCommand;
  const muxAvailable = deps.muxAvailable ?? isMuxAvailable;
  const runningNames = () => [...new Set(Array.from(runningSubagents.values()).map((r) => r.name))];

  const steer: Transport = {
    known: runningNames,
    deliver(to, message) {
      const matches = Array.from(runningSubagents.values()).filter((r) => r.name === to);
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
        return {
          status: "transport-failed",
          reason: `Ambiguous subagent name "${to}". Matches: ${candidates}`,
        };
      }
      if (!muxAvailable()) return muxUnavailableDelivery();
      return steerRunning(matches[0], message, send);
    },
  };

  const resume: Transport = {
    known(ctx) {
      const dir = parentArtifactDirOf(ctx);
      return dir ? Object.keys(readNameRegistry(dir)) : [];
    },

    async deliver(to, message, ctx) {
      // Pass, never throw, on a name this session cannot resume: the router
      // must still reach the transports behind this one. Both checks precede
      // the tmux probe, so an unknown name is passed on rather than reported
      // as a tmux failure.
      const parentArtifactDir = parentArtifactDirOf(ctx);
      if (!parentArtifactDir) return null;

      const entry = resolveNameInRegistry(parentArtifactDir, to);
      if (!entry) return null;

      if (!muxAvailable()) return muxUnavailableDelivery();

      const name = to; // identity preservation: the resumed run reclaims its name
      const { autoExit, interactive } = RESUME_LAUNCH;
      const startTime = Date.now();
      const id = Math.random().toString(16).slice(2, 10);

      const sessionPath = entry.sessionFile;
      if (!sessionPath || !existsSync(sessionPath)) {
        return {
          status: "unresumable",
          reason:
            `Subagent "${to}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`,
        };
      }

      // Guard: never resume a session that is still running — two processes
      // mutating the same .jsonl corrupts it. Steer it by name instead.
      for (const r of runningSubagents.values()) {
        if (resolve(r.sessionFile) === resolve(sessionPath)) {
          return steerRunning(r, message, send);
        }
      }

      // Reconstruct the sandbox from the snapshot written at spawn time.
      // Without it we cannot safely resume: relaunching bare would load every
      // global extension + the full toolset. Refuse rather than escalate.
      const loadout = readSubagentLoadout(sessionPath);
      if (!loadout) {
        return {
          status: "unresumable",
          reason:
            `Cannot safely resume "${to}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`,
        };
      }

      const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? to;

      // Record entry count before resuming so we can extract new messages.
      // Count lines cheaply (no per-line JSON.parse) so resuming a large
      // transcript doesn't block the UI.
      const entryCountBefore = countSessionEntryLines(sessionPath);

      const surface = createSurface(name);
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

      // Build pi resume command
      const parts = ["pi", "--session", shellEscape(sessionPath)];

      // Load subagent-done extension so the agent can self-terminate if needed
      const subagentDonePath = paths.childEntry;
      parts.push("-e", shellEscape(subagentDonePath));

      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
      const activityFile = getSubagentActivityFile(artifactDir, id);
      mkdirSync(dirname(activityFile), { recursive: true });

      // Replay the model, identity, and default-deny tool/extension sandbox.
      parts.push(...sandboxArgs(loadout, { artifactDir, name }));

      let resumeMsgFile: string | undefined;
      if (message) {
        const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        resumeMsgFile = join(
          artifactDir,
          "subagent-resume",
          `${slugify(name, "resume")}-${msgTimestamp}.md`,
        );
        mkdirSync(dirname(resumeMsgFile), { recursive: true });
        writeFileSync(resumeMsgFile, message, "utf8");
        parts.push(shellEscape(`@${resumeMsgFile}`));
      }

      // Build env prefix — replay the snapshot's config dir + spawn whitelist
      // so the resumed process resolves the same agents/extensions and keeps
      // the same nested-spawn restriction it originally ran with.
      const resumeEnvParts: string[] = [];
      const resumeAgentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
      if (resumeAgentDir) {
        resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumeAgentDir)}`);
      }
      if (loadout.agent) {
        resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
      }
      resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
      resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
      resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
      resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
      if (autoExit) {
        resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
      }
      const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

      // Resume in the subagent's original cwd so its tools (safe_bash, edits)
      // operate where they did before.
      const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

      runSubagent(pi, {
        id,
        name,
        task: message,
        surface,
        sessionFile: sessionPath,
        artifactDir,
        activityFile,
        interactive,
        startTime,
        command: resumeCdPrefix + resumeEnvPrefix + parts.join(" "),
        kind: "resume",
        // Report only what this run adds, not the transcript it inherited.
        fromEntry: entryCountBefore,
      });

      return { status: "resumed", name, sessionId: resumedSessionId };
    },
  };

  return [steer, resume];
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: SPAWN_GUIDANCE,
      promptSnippet: SPAWN_SNIPPET,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Every reason a spawn may be refused, in one ordered decision. The
        // environment is resolved here because refuseSpawn reads nothing itself.
        const refusal = refuseSpawn(params, {
          permitted: () => listAgents().map((a) => a.name),
          muxAvailable: isMuxAvailable,
          hasSessionFile: () => !!ctx.sessionManager.getSessionFile(),
          muxUnavailableMessage,
        });
        if (refusal) {
          const { text, error } = describeRefusal(refusal);
          return { content: [{ type: "text" as const, text }], details: { error } };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Default the cosmetic pane label to the agent name when omitted,
        // disambiguating against running subagents, in-flight reservations, and
        // every name already in the registry — so names stay unique across the
        // whole session, running or finished. Reserve the chosen name
        // synchronously (before any await) so parallel spawns don't collide.
        let reservedName: string | null = null;
        let launchName = params.name;
        if (!launchName?.trim()) {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          launchName = uniqueRunningName(params.agent, registryNames);
          reservedName = launchName;
          reservedNames.add(reservedName);
        }
        params.name = launchName;

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent(pi, { ...params, name: launchName }, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so send_message({ to }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
        });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List the agent profiles you can spawn, with the model and tools each one runs. Read it " +
        "when you are unsure which profile fits a task. These are role definitions, not running " +
        "sub-agents: a name here goes in `subagent({ agent })`, never in `send_message({ to })`. " +
        "A project's .pi/agents/ shadows the global ones by name.",
      promptSnippet:
        "List the agent profiles available to spawn. Role definitions, not running sub-agents.",
      parameters: Type.Object({}),

      async execute() {
        const list = listAgents().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  registerSendMessage(pi, "children", createChildTransports(pi));

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = resolveAgentLaunch(agentName).defs;
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = usageSegments(stats).map((s) => theme.fg(USAGE_TONE[s.severity], s.text));
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = stripResultPreamble(rawContent, {
          name,
          elapsedText: elapsed,
          exitCode,
        });

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  send_message({ to: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_message renderer ──
  pi.registerMessageRenderer("subagent_message", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "↑");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— waiting on your reply")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: send_message({ to: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
