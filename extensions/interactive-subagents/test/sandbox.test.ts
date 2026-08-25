import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeToolAllowlist,
  sandboxArgs,
  promptArgs,
  getToolExtensionPath,
  slugify,
  SUBAGENT_CONTROL_TOOLS,
} from "../sandbox.ts";
import type { SubagentLoadout } from "../loadout.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BARE: SubagentLoadout = {
  agent: null,
  toolAllowlist: null,
  model: null,
  thinking: null,
  systemPromptMode: null,
  identity: null,
  autoExit: false,
  cwd: null,
  agentDir: null,
};

const loadout = (over: Partial<SubagentLoadout> = {}): SubagentLoadout => ({ ...BARE, ...over });

describe("sandbox.ts", () => {
  describe("computeToolAllowlist", () => {
    it("passes no allowlist at all when nothing is restricted or granted", () => {
      assert.equal(computeToolAllowlist(undefined), null);
      assert.equal(computeToolAllowlist(""), null);
    });

    it("keeps requested tools and always adds the control tools", () => {
      const allow = computeToolAllowlist("read,bash");
      assert.ok(allow);
      const tools = allow!.split(",");
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("bash"));
      for (const control of SUBAGENT_CONTROL_TOOLS) {
        assert.ok(tools.includes(control), `expected ${control} to always be granted`);
      }
    });

    it("does not repeat a tool that was requested and is also always granted", () => {
      const tools = computeToolAllowlist("send_message,read")!.split(",");
      assert.equal(tools.filter((t) => t === "send_message").length, 1);
    });
  });

  describe("sandboxArgs", () => {
    it("returns nothing for a loadout that restricts nothing", () => {
      withTempDir((dir) => {
        assert.deepEqual(sandboxArgs(loadout(), { artifactDir: dir, name: "w" }), []);
      });
    });

    it("passes the model, joining thinking level with a colon", () => {
      withTempDir((dir) => {
        assert.deepEqual(
          sandboxArgs(loadout({ model: "x/y" }), { artifactDir: dir, name: "w" }),
          ["--model", "'x/y'"],
        );
        assert.deepEqual(
          sandboxArgs(loadout({ model: "x/y", thinking: "high" }), { artifactDir: dir, name: "w" }),
          ["--model", "'x/y:high'"],
        );
      });
    });

    it("writes the identity to a file and points the right flag at it", () => {
      withTempDir((dir) => {
        const args = sandboxArgs(
          loadout({ identity: "you are a test", systemPromptMode: "replace" }),
          { artifactDir: dir, name: "My Worker" },
        );
        assert.equal(args[0], "--system-prompt");

        const written = readdirSync(join(dir, "context"));
        assert.equal(written.length, 1);
        assert.match(written[0], /^my-worker-sysprompt-/, "file is named after the subagent");
        assert.equal(readFileSync(join(dir, "context", written[0]), "utf8"), "you are a test");
      });
    });

    it("appends rather than replaces by default", () => {
      withTempDir((dir) => {
        const args = sandboxArgs(loadout({ identity: "hi" }), { artifactDir: dir, name: "w" });
        assert.equal(args[0], "--append-system-prompt");
      });
    });

    it("default-denies extensions and re-enables only what backs a granted tool", () => {
      withTempDir((dir) => {
        const args = sandboxArgs(
          loadout({ toolAllowlist: "read,web_search,web_fetch" }),
          { artifactDir: dir, name: "w" },
        );
        assert.ok(args.includes("--no-extensions"));
        assert.ok(args.includes("--tools"));
        // read is built in, so it contributes no -e.
        const eFlags = args.filter((a, i) => args[i - 1] === "-e");
        assert.equal(eFlags.length, 2);
        assert.ok(eFlags.some((p) => p.includes("web-search")));
        assert.ok(eFlags.some((p) => p.includes("web-fetch")));
      });
    });

    it("emits one -e per backing extension, not per tool", () => {
      withTempDir((dir) => {
        // Every cbmem tool comes from one flat file.
        const args = sandboxArgs(
          loadout({ toolAllowlist: "search_graph,trace_path,get_code_snippet" }),
          { artifactDir: dir, name: "w" },
        );
        const eFlags = args.filter((a, i) => args[i - 1] === "-e");
        assert.equal(new Set(eFlags).size, eFlags.length, "no duplicate -e");
        assert.ok(eFlags.length <= 1, `expected at most one backing file, got ${eFlags.length}`);
      });
    });

    it("replays an unrestricted loadout without a tool restriction", () => {
      withTempDir((dir) => {
        const args = sandboxArgs(loadout({ toolAllowlist: null, model: "m" }), {
          artifactDir: dir,
          name: "w",
        });
        assert.ok(!args.includes("--no-extensions"));
        assert.ok(!args.includes("--tools"));
      });
    });
  });

  describe("getToolExtensionPath", () => {
    it("returns nothing for built-ins and unknown tools", () => {
      for (const builtin of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
        assert.equal(getToolExtensionPath(builtin), undefined);
      }
      assert.equal(getToolExtensionPath("no_such_tool"), undefined);
    });

  });

  describe("promptArgs", () => {
    it("passes the task through when there are no skills", () => {
      assert.deepEqual(promptArgs({ taskDelivery: "artifact", taskArg: "@file.md" }), ["@file.md"]);
    });

    it("turns skills into /skill: prompts", () => {
      assert.deepEqual(
        promptArgs({ effectiveSkills: "a, b", taskDelivery: "direct", taskArg: "do it" }),
        ["/skill:a", "/skill:b", "do it"],
      );
    });

    it("prepends an empty message so /skill: survives artifact-backed delivery", () => {
      // pi concatenates @file content into messages[0]; a leading empty message
      // pushes the skill prompts into messages[1..] where /skill: is recognized.
      assert.deepEqual(
        promptArgs({ effectiveSkills: "a", taskDelivery: "artifact", taskArg: "@file.md" }),
        ["", "/skill:a", "@file.md"],
      );
    });

    it("does not prepend one when there is nothing to protect", () => {
      assert.deepEqual(
        promptArgs({ effectiveSkills: "", taskDelivery: "artifact", taskArg: "@file.md" }),
        ["@file.md"],
      );
    });
  });

  describe("slugify", () => {
    it("makes a name filename-safe", () => {
      assert.equal(slugify("My Worker"), "my-worker");
      assert.equal(slugify("a//b  c"), "ab-c");
    });

    it("falls back when a name has no usable characters", () => {
      assert.equal(slugify("!!!"), "subagent");
      assert.equal(slugify("...", "resume"), "resume");
    });
  });
});
