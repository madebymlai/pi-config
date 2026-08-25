/**
 * Smoke-test every extension the way pi's loader does.
 *
 * Discovery mirrors dist/core/extensions/loader.js: a direct `extensions/*.ts`
 * file, an `extensions/<dir>/index.ts`, or whatever an `extensions/<dir>/package.json`
 * declares under its `pi` field. No recursion beyond one level.
 *
 * Each entry is imported and handed a stub ExtensionAPI that records what it
 * registers. Typechecking alone misses this class of breakage: an extension can
 * compile and still throw at load time when pi renames or drops an API it calls.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions");

function entriesFor(dir: string) {
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    const declared = JSON.parse(readFileSync(manifest, "utf8"))?.pi?.extensions;
    if (Array.isArray(declared)) return declared.map((e: string) => join(dir, e));
  }
  const index = join(dir, "index.ts");
  return existsSync(index) ? [index] : [];
}

function discover() {
  const found: string[] = [];
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    const path = join(extensionsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
    else if (entry.isDirectory()) found.push(...entriesFor(path));
  }
  return found.sort();
}

/** Records every registration so a load can be reported as more than "didn't throw". */
function recordingApi() {
  const surface: Record<string, string[]> = {
    tools: [],
    commands: [],
    events: [],
    shortcuts: [],
    renderers: [],
    flags: [],
  };
  const noop = () => {};
  const api = {
    registerTool: (tool: { name: string }) => surface.tools.push(tool.name),
    registerCommand: (name: string) => surface.commands.push(`/${name}`),
    registerEntryRenderer: (name: string) => surface.renderers.push(name),
    registerMessageRenderer: (name: string) => surface.renderers.push(name),
    registerShortcut: (s: { key?: string }) => surface.shortcuts.push(s?.key ?? String(s)),
    registerFlag: (name: string) => surface.flags.push(name),
    registerAutocompleteProvider: noop,
    registerMarkdownTransformer: noop,
    on: (name: string) => surface.events.push(name),
    setWidget: noop,
    setHeader: noop,
    setFooter: noop,
    getThinkingLevel: () => "high",
    log: noop,
  };
  return { api, surface };
}

let failed = 0;
for (const entry of discover()) {
  const name = entry.slice(extensionsDir.length + 1);
  const { api, surface } = recordingApi();
  try {
    const factory = (await import(entry)).default;
    if (typeof factory !== "function") throw new Error("no default export function");
    await factory(api);
    const summary = Object.entries(surface)
      .filter(([, values]) => values.length > 0)
      .map(([kind, values]) => `${kind}=[${values.join(", ")}]`)
      .join(" ");
    console.log(`OK   ${name.padEnd(26)} ${summary || "(registers nothing at load)"}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name.padEnd(26)} ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(failed === 0 ? "\nall extensions load" : `\n${failed} extension(s) failed to load`);
process.exit(failed === 0 ? 0 : 1);
