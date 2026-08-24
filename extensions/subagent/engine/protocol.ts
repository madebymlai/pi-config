/** How the engine talks to a Pi child: how it is invoked, and what its output means. */

import type { Message } from "@earendil-works/pi-ai";

const AGENT_LEAF_ENV = "PI_AGENT_LEAF";
const AGENT_LEAF_VALUE = "1";

/** Excluded from every child: these are the tools that would let it delegate again. */
const CHILD_ORCHESTRATION_TOOL_NAMES = [
  "subagent",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
] as const;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Something a child produced while it was still running. */
export type ChildEvent =
  | { type: "message"; message: Message }
  | { type: "tool-result"; message: Message };

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** What a child actually said: the text of the last assistant message carrying any. */
export function getFinalText(result: { messages: Message[] }, fallback = "(no output)"): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return fallback;
}

export function isLeafProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_LEAF_ENV] === AGENT_LEAF_VALUE;
}

/** Mark a child's environment as a leaf without dropping any parent value. */
export function leafEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [AGENT_LEAF_ENV]: AGENT_LEAF_VALUE };
}

/** The child's whole command line. The prompt is never one of these: it goes over stdin. */
export function childArgs(run: { model?: string; thinking?: string; tools?: string[] }): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates"];
  if (run.model) args.push("--model", run.model);
  if (run.thinking) args.push("--thinking", run.thinking);
  if (run.tools) {
    if (run.tools.length > 0) args.push("--tools", run.tools.join(","));
    else args.push("--no-tools");
  }
  args.push("--exclude-tools", CHILD_ORCHESTRATION_TOOL_NAMES.join(","));
  return args;
}

/** Everything read off a child's NDJSON stream so far. */
export interface ChildTranscript {
  messages: Message[];
  usage: UsageTotals;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function createTranscript(): ChildTranscript {
  return { messages: [], usage: emptyUsage() };
}

/** Fold one NDJSON line into the transcript. Unparseable and unknown lines are ignored. */
export function acceptLine(
  transcript: ChildTranscript,
  line: string,
  emit?: (event: ChildEvent) => void,
): void {
  if (!line.trim()) return;
  let event: { type?: string; message?: Message };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  // Anything that is not shaped like a message is dropped here, so no malformed
  // child output can reach a caller reading the transcript.
  if (!event.message || !Array.isArray(event.message.content)) return;
  const message = event.message;
  if (event.type === "message_end") {
    transcript.messages.push(message);
    if (message.role === "assistant") accountForTurn(transcript, message);
    emit?.({ type: "message", message });
    return;
  }
  if (event.type === "tool_result_end") {
    transcript.messages.push(message);
    emit?.({ type: "tool-result", message });
  }
}

function accountForTurn(transcript: ChildTranscript, message: Message & { role: "assistant" }) {
  transcript.usage.turns++;
  const usage = message.usage;
  if (usage) {
    transcript.usage.input += usage.input || 0;
    transcript.usage.output += usage.output || 0;
    transcript.usage.cacheRead += usage.cacheRead || 0;
    transcript.usage.cacheWrite += usage.cacheWrite || 0;
    transcript.usage.cost += usage.cost?.total || 0;
    transcript.usage.contextTokens = usage.totalTokens || 0;
  }
  if (!transcript.model && message.model) transcript.model = message.model;
  if (message.stopReason) transcript.stopReason = message.stopReason;
  if (message.errorMessage) transcript.errorMessage = message.errorMessage;
}
