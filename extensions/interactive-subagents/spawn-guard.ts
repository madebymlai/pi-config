/**
 * Whether a spawn may proceed, and if not, why.
 *
 * Every refusal is a value in a closed union, the way `Delivery` works in
 * messaging.ts. Before this, five refusals each hand-built their own
 * `{ content: [...], details: { error } }` payload inline in the tool, which
 * meant a sixth refusal was a sixth payload nobody could check, and the guard
 * ORDER — real policy, since a self-spawn should be reported as a self-spawn
 * even when the environment is also broken — was only observable by driving the
 * whole tool.
 *
 * `refuseSpawn` reads nothing: no env vars, no filesystem, no tmux probe. The
 * caller resolves those into a `SpawnEnvironment`, which is what lets the order
 * be tested directly.
 */
import { PARENT } from "./messaging.ts";

export type SpawnRefusal =
  /** An agent tried to spawn another copy of itself. */
  | { status: "self-spawn"; agent: string }
  /** No agent named. There is no agentless spawn route. */
  | { status: "agent-required"; permitted: string[] }
  /** Named an agent this session may not spawn, because it was pinned to a set. */
  | { status: "not-in-allowlist"; agent: string; permitted: string[] }
  /** Named an agent that does not exist. */
  | { status: "unknown-agent"; agent: string; permitted: string[] }
  /** `parent` addresses the spawner, so a subagent may not hold it. */
  | { status: "reserved-name" }
  | { status: "no-mux"; message: string }
  | { status: "no-session-file" };

export interface SpawnRequest {
  agent?: string;
  name?: string;
}

/**
 * Resolved on demand, in guard order, never all at once. An invalid request is
 * therefore refused without discovering agents, probing tmux, or touching
 * session state — so a malformed spawn can never fail for an unrelated
 * environmental reason, and callers may pass a context that is not ready yet.
 */
export interface SpawnEnvironment {
  /** The agent this process is itself running as, when it is a subagent. */
  currentAgent?: string;
  /** Agents this session may spawn. */
  permitted: () => string[];
  /** True when `permitted` comes from PI_SUBAGENT_ALLOWED rather than discovery. */
  restricted: boolean;
  muxAvailable: () => boolean;
  hasSessionFile: () => boolean;
  /** What to tell the caller when the multiplexer is missing, quoted verbatim. */
  muxUnavailableMessage: () => string;
}

/**
 * The first reason this spawn may not proceed, or null if it may.
 *
 * Order is deliberate and tested: self-spawn, then the agent whitelist, then the
 * reserved name, then environment prerequisites. Identity problems outrank
 * environment ones so the caller is told the most specific thing wrong with the
 * request rather than whichever check ran first.
 */
export function refuseSpawn(request: SpawnRequest, env: SpawnEnvironment): SpawnRefusal | null {
  // Deliberately NOT trimmed. The name is matched against the permitted set and
  // then used downstream to load the role file, so accepting " scout " here
  // would pass the whitelist and then miss agents/scout.md, leaving the child
  // with no role, no tool restriction and every extension — the exact
  // escalation this guard exists to prevent. A padded name is not a known agent.
  const agent = request.agent;

  if (agent && env.currentAgent && agent === env.currentAgent) {
    return { status: "self-spawn", agent: env.currentAgent };
  }

  // Strict whitelist at every depth. Without this a missing or unknown agent
  // would silently launch an unrestricted, full-toolset child.
  const permitted = env.permitted();
  if (!agent) return { status: "agent-required", permitted };
  if (!permitted.includes(agent)) {
    const status = env.restricted ? "not-in-allowlist" : "unknown-agent";
    return { status, agent, permitted };
  }

  if (request.name?.trim() === PARENT) return { status: "reserved-name" };

  if (!env.muxAvailable()) return { status: "no-mux", message: env.muxUnavailableMessage() };
  // Needed to derive the artifact dir that hosts this session's name registry.
  if (!env.hasSessionFile()) return { status: "no-session-file" };

  return null;
}

/**
 * The refusal as the orchestrator sees it: `text` is what it reads, `error` is
 * the stable slug recorded in the tool result's details.
 *
 * The explicit return type is load-bearing, not decoration. Without it an
 * unhandled variant infers `| undefined`, which still fails the build — but at
 * whichever call site destructures the result (TS2339), not here. Annotating
 * keeps the error on the switch that is actually missing a case.
 */
export function describeRefusal(refusal: SpawnRefusal): { text: string; error: string } {
  switch (refusal.status) {
    case "self-spawn":
      return {
        text:
          `You are the ${refusal.agent} agent — do not start another ${refusal.agent}. ` +
          `You were spawned to do this work yourself. Complete the task directly.`,
        error: "self-spawn blocked",
      };

    case "agent-required":
      return {
        text:
          `You must specify which agent to spawn via the "agent" field. ` +
          `Available agents: ${listOf(refusal.permitted)}.`,
        error: "agent required",
      };

    case "not-in-allowlist":
      return {
        text:
          `You may not spawn the "${refusal.agent}" agent — it is not ` +
          `in your allowlist. Available agents: ${listOf(refusal.permitted)}.`,
        error: "agent not in allowlist",
      };

    case "unknown-agent":
      return {
        text:
          `You may not spawn the "${refusal.agent}" agent — it is not ` +
          `a known agent. Available agents: ${listOf(refusal.permitted)}.`,
        error: "unknown agent",
      };

    case "reserved-name":
      return {
        text:
          `"${PARENT}" is reserved: send_message uses it to address the agent that ` +
          `spawned you. Name this subagent something else.`,
        error: "reserved name",
      };

    case "no-mux":
      return { text: refusal.message, error: "tmux not available" };

    case "no-session-file":
      return {
        text: "Error: no session file. Start pi with a persistent session to use subagents.",
        error: "no session file",
      };
  }
}

function listOf(agents: string[]) {
  return agents.join(", ") || "(none)";
}
