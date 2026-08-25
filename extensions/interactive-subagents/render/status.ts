import { readFileSync } from "node:fs";
import type {
  StatusSnapshot,
  SubagentStatusTransition,
} from "../observe/status-snapshot.ts";
import { paths } from "../paths.ts";

export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

function readStatusConfigFile(configPath: string, examplePath: string): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath = paths.statusConfig,
  examplePath = paths.statusConfigExample,
): StatusConfig {
  const { sourcePath, rawConfig } = readStatusConfigFile(configPath, examplePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return parseStatusConfig(parsed, sourcePath);
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`);
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel && snapshot.statusLabel !== "done"
      ? ` (${snapshot.statusLabel})`
      : snapshot.statusLabel === "done"
        ? " (done)"
        : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`);
  }

  return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`);
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
