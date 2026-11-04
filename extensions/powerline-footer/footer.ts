import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  parseColor,
  truncateToWidth,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";

export interface FooterSnapshot {
  model: string;
  thinking: string;
  input: number;
  output: number;
  used: number | null;
  contextWindow: number;
  project: string;
  branch?: string;
  statuses: ReadonlyMap<string, string>;
}

const mocha = {
  base: parseColor("#1e1e2e"),
  surface: parseColor("#313244"),
  overlay: parseColor("#45475a"),
  text: parseColor("#cdd6f4"),
  mauve: parseColor("#cba6f7"),
  green: parseColor("#a6e3a1"),
  peach: parseColor("#fab387"),
  red: parseColor("#f38ba8"),
};

function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function clean(text: string): string {
  return (
    stripVTControlCharacters(text)
      .replace(/[\r\n\t\u2028\u2029]/g, " ")
      // Strip terminal controls and bidi overrides from external display labels.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/ +/g, " ")
      .trim()
  );
}

type Segment = { text: string; bg: Color; fg: Color };

export class Footer {
  private readonly snapshot: () => FooterSnapshot;
  private readonly theme: Pick<Theme, "style">;

  constructor(snapshot: () => FooterSnapshot, theme: Pick<Theme, "style">) {
    this.snapshot = snapshot;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const raw = this.snapshot();
    const s = {
      ...raw,
      model: clean(raw.model),
      thinking: clean(raw.thinking),
      project: clean(raw.project),
      branch: clean(raw.branch ?? ""),
    };
    const known = s.used !== null && s.contextWindow > 0;
    const ratio = known ? s.used! / s.contextWindow : 0;
    const filled = Math.max(0, Math.min(10, Math.floor(ratio * 10)));
    const used = s.used === null ? "?" : tokens(s.used);
    const bar = known
      ? `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`
      : "░".repeat(10);
    const segments: Segment[] = [
      { text: `${s.model} ${s.thinking}`, bg: mocha.mauve, fg: mocha.base },
      {
        text: `↑${tokens(s.input)} ↓${tokens(s.output)}`,
        bg: mocha.surface,
        fg: mocha.text,
      },
      {
        text: `${bar} ${used}`,
        bg: mocha.overlay,
        fg: !known
          ? mocha.text
          : ratio >= 0.9
            ? mocha.red
            : ratio >= 0.7
              ? mocha.peach
              : mocha.green,
      },
    ];
    const guard = clean(s.statuses.get(" bash-guard") ?? "");
    if (guard)
      segments.push({
        text: guard,
        bg: guard.includes("OFF") ? mocha.red : mocha.green,
        fg: mocha.base,
      });
    const project: Segment = {
      text: `${s.project}${s.branch ? `  ${s.branch}` : ""}`,
      bg: mocha.surface,
      fg: mocha.text,
    };
    const size = (parts: Segment[]) =>
      parts.reduce((n, part) => n + visibleWidth(part.text) + 3, 0);
    for (const [key, value] of [...s.statuses].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (key === " bash-guard") continue;
      const text = clean(value);
      if (!text) continue;
      const status = { text, bg: mocha.surface, fg: mocha.text };
      if (size([...segments, status]) <= width) segments.push(status);
    }
    if (size([...segments, project]) <= width) segments.push(project);
    if (size(segments) > width) {
      const safety = guard;
      const room = Math.max(0, width - visibleWidth(safety) - (safety ? 1 : 0));
      const detail = truncateToWidth(
        `${s.model} ${s.thinking} ↑${tokens(s.input)} ↓${tokens(s.output)} ${used}`,
        room,
        "",
      );
      const text = detail
        ? `${detail}${safety ? ` ${safety}` : ""}`
        : truncateToWidth(safety, width, "");
      const line = this.theme.style(text, {
        fg: guard.includes("OFF") ? mocha.red : mocha.text,
        bg: mocha.base,
      });
      return [line.includes("\u001b") ? line + "\u001b[0m" : line];
    }
    let line = segments
      .map(
        (segment, index) =>
          this.theme.style(` ${segment.text} `, {
            fg: segment.fg,
            bg: segment.bg,
          }) +
          this.theme.style("", {
            fg: segment.bg,
            bg: segments[index + 1]?.bg ?? mocha.base,
          }),
      )
      .join("");
    line += this.theme.style(
      " ".repeat(Math.max(0, width - visibleWidth(line))),
      { fg: mocha.text, bg: mocha.base },
    );
    return [line.includes("\u001b") ? line + "\u001b[0m" : line];
  }
}
