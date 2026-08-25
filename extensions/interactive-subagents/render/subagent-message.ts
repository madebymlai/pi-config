/**
 * A subagent that has messaged its parent and is now blocked on the reply.
 *
 * The reply hint names the subagent because that name is the address: it is what
 * send_message({ to }) takes, and a reader who cannot see it has no way to
 * unblock the subagent.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { asRecord, type RenderContext } from "./theme.ts";

export interface SubagentMessageDetails {
  /** Addressable name, which is what a reply must be sent to. */
  name: string;
  /** The role it was spawned as, when it was spawned as one. */
  agent?: string;
  message: string;
}

/** Reads a message's untyped details, or null when this is not our message. */
export function readSubagentMessageDetails(details: unknown): SubagentMessageDetails | null {
  const record = asRecord(details);
  if (!record) return null;
  return {
    name: typeof record.name === "string" ? record.name : "subagent",
    agent: typeof record.agent === "string" && record.agent ? record.agent : undefined,
    message: typeof record.message === "string" ? record.message : "",
  };
}

export function renderSubagentMessage(
  details: SubagentMessageDetails,
  { theme, expandHint, expanded, width }: RenderContext,
) {
  const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
  const icon = theme.fg("accent", "↑");
  const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.name))}${agentTag} ${theme.fg("dim", "— waiting on your reply")}`;

  const contentLines = [header];

  if (expanded) {
    contentLines.push("");
    contentLines.push(details.message);
    contentLines.push("");
    contentLines.push(
      theme.fg("dim", `Reply: send_message({ to: "${details.name}", message: "…" })`),
    );
  } else {
    const preview = details.message.split("\n")[0].slice(0, width - 10);
    contentLines.push(theme.fg("dim", preview));
    contentLines.push(theme.fg("muted", expandHint()));
  }

  const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
  box.addChild(new Text(contentLines.join("\n"), 0, 0));
  return ["", ...box.render(width)];
}
