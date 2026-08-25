/**
 * One agent profile, as a line.
 *
 * subagents_list renders the same list twice: once as plain text for the model
 * that called it, once themed for the reader watching. Those were two copies of
 * the same assembly, so a change to what a profile shows had to be made in both
 * or the two would say different things.
 *
 * One formatter, given a theme that either paints or does not.
 */
import type { ListedAgentDefinition } from "../spawn/agents.ts";
import { asRecord, UNPAINTED, type RenderTheme } from "./theme.ts";

export const NO_AGENTS_MESSAGE = "No subagent definitions found.";

/** Reads the agent list off a tool result's untyped details. */
export function readListedAgents(details: unknown): ListedAgentDefinition[] {
  const agents = asRecord(details)?.agents;
  if (!Array.isArray(agents)) return [];
  // A line needs a name; anything without one has nothing to render.
  return agents.filter(
    (agent): agent is ListedAgentDefinition =>
      asRecord(agent) != null && typeof (agent as ListedAgentDefinition).name === "string",
  );
}

export function formatAgentLine(
  agent: Pick<ListedAgentDefinition, "name" | "source" | "model" | "description">,
  options: { theme?: RenderTheme; bullet: string },
) {
  const theme = options.theme ?? UNPAINTED;
  // A project agent shadows a global one by name, so which tier it came from is
  // the difference between two identically named profiles.
  const badge = agent.source === "project" ? theme.fg("accent", " (project)") : "";
  const model = agent.model ? theme.fg("dim", ` [${agent.model}]`) : "";
  const description = agent.description ? theme.fg("dim", ` — ${agent.description}`) : "";
  return `${options.bullet}${theme.fg("toolTitle", theme.bold(agent.name))}${badge}${model}${description}`;
}
