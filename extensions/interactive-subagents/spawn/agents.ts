/**
 * What an agent role is, where roles come from, and what launching one means.
 *
 * The interface is two functions and a constant. Before this module a caller
 * had to know a sequence: load the defaults, then hand them separately to a
 * session-mode resolver, a launch-behaviour resolver, and an interactive
 * resolver, each re-deriving from the same defaults. That ordering was part of
 * the interface without being written down anywhere. `resolveAgentLaunch` is
 * the one call those four were always building up to.
 *
 * Discovery runs over three tiers — the roles bundled with this extension, the
 * user's global agent dir, and the project's `.pi/agents` — with later tiers
 * shadowing earlier ones by name.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir, paths } from "../paths.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * Where pi keeps its agent configuration.
 *
 * This lives here rather than in its own module because agent discovery is its
 * main consumer and a three-line environment lookup behind its own file would
 * be a pass-through. The sandbox imports it from here to resolve extension
 * paths under the agent dir.
 */
function getBundledAgentsDir(): string {
  return paths.bundledAgents;
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/**
 * Every agent that can be spawned, project tier shadowing global shadowing
 * bundled. Only the top-level session spawns, so there is nothing to narrow
 * this by.
 */
export function listAgents() {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const candidates = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

export interface AgentLaunch {
  /** Parsed frontmatter, or null for an agentless or unknown spawn. */
  defs: AgentDefaults | null;
  sessionMode: SubagentSessionMode;
  /** Which seeding the child session needs, or null when it starts empty. */
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  /** User-driven and long-running: transitions stay in its own pane. */
  interactive: boolean;
  autoExit: boolean;
}

/**
 * Resolve an agent name to everything a launch needs to know about it.
 *
 * An unknown name resolves the same as no name at all: standalone defaults with
 * null `defs`. Callers that must reject an unknown agent check discoverability
 * against `listAgents`, which is a policy question rather than a resolution one.
 *
 * `interactive` defaults to the inverse of `auto-exit`: agents that auto-exit
 * are autonomous (scout, researcher) and the parent should be woken on
 * stall/recovery transitions, while agents that don't are driven by the user in
 * their own pane (worker) where stall pings are noise. Explicit `interactive`
 * frontmatter wins over that default.
 */
export function resolveAgentLaunch(agentName: string | undefined): AgentLaunch {
  const defs = agentName ? loadAgentDefaults(agentName) : null;
  const sessionMode = defs?.sessionMode ?? "standalone";
  const inheritsConversationContext = sessionMode === "fork";

  return {
    defs,
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
    interactive: defs?.interactive ?? !(defs?.autoExit ?? false),
    autoExit: defs?.autoExit ?? false,
  };
}

/**
 * Resuming a finished session is always autonomous: the relaunched agent runs
 * its follow-up task to completion and the harness delivers the result as a
 * steer message (fire-and-forget). An interactive resume would park the pane
 * waiting for the user, contradicting that result-delivery model.
 */
export const RESUME_LAUNCH = {
  autoExit: true,
  interactive: false,
};
