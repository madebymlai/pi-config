/**
 * Where everything in this package lives.
 *
 * Before this module, four files each computed their own location from
 * `import.meta.url` and navigated relative to it: sandbox.ts reached ".." for
 * sibling extensions, agents.ts reached "agents/", index.ts reached
 * "subagent-done.ts", status.ts reached "config.json". Four independent
 * assumptions about the layout, and moving any file silently changed what its
 * own ".." meant. Those break at runtime, not at compile time, which is the
 * worst way for a path to be wrong.
 *
 * So layout is one module's job. Nothing else in this package may call
 * `import.meta.url`: ask here instead, and moving a file becomes a one-line
 * edit in one place.
 *
 * The root is found by walking up to the nearest package.json rather than by
 * counting "..", so this file does not care how deep it is itself.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `interactive-subagents: no package.json in any ancestor of ${start}, so the package root cannot be located.`,
      );
    }
    dir = parent;
  }
}

const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export const paths = {
  root: PACKAGE_ROOT,

  /** The extension injected with `-e` into every subagent session. */
  childEntry: join(PACKAGE_ROOT, "subagent-done.ts"),

  /** Agent role definitions bundled with this package (the first discovery tier). */
  bundledAgents: join(PACKAGE_ROOT, "agents"),

  /** A tool extension loaded into a child, by path segments under tools/. */
  toolExtension: (...segments: string[]) => join(PACKAGE_ROOT, "tools", ...segments),

  /**
   * Extensions installed beside this one. This package is not always under
   * ~/.pi/agent: vendored into a config repo, the extensions backing granted
   * tools sit next to it.
   */
  siblingExtensions: resolve(PACKAGE_ROOT, ".."),

  statusConfig: join(PACKAGE_ROOT, "config.json"),
  statusConfigExample: join(PACKAGE_ROOT, "config.json.example"),
};

/** The user's pi agent directory, which is configuration rather than layout. */
export function getAgentConfigDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
