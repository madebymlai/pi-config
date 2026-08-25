import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentLaunch, RESUME_LAUNCH, listAgents } from "../spawn/agents.ts";
import { withIsolatedAgentEnv, writeAgentFile } from "./support/agent-env.ts";

/** Write one project-tier agent and resolve it, all inside a throwaway env. */
async function launchOf(frontmatter: string[], name = "fixture-agent") {
  let result!: ReturnType<typeof resolveAgentLaunch>;
  await withIsolatedAgentEnv(({ projectAgentsDir }) => {
    writeAgentFile(projectAgentsDir, name, [`name: ${name}`, ...frontmatter].join("\n"));
    result = resolveAgentLaunch(name);
  });
  return result;
}

describe("agents.ts", () => {
  describe("resolveAgentLaunch", () => {
    it("resolves an unknown agent to standalone defaults without throwing", async () => {
      await withIsolatedAgentEnv(() => {
        const launch = resolveAgentLaunch("no-such-agent-anywhere");
        assert.equal(launch.defs, null);
        assert.equal(launch.sessionMode, "standalone");
        assert.equal(launch.seededSessionMode, null);
        assert.equal(launch.inheritsConversationContext, false);
        assert.equal(launch.taskDelivery, "artifact");
      });
    });

    it("resolves an agentless launch the same way as an unknown one", async () => {
      await withIsolatedAgentEnv(() => {
        assert.deepEqual(resolveAgentLaunch(undefined), resolveAgentLaunch("no-such-agent"));
      });
    });

    it("returns the parsed frontmatter alongside the resolved policy", async () => {
      const launch = await launchOf([
        "model: anthropic/test-model",
        "tools: read,bash",
        "thinking: high",
        "session-mode: lineage-only",
      ]);

      assert.ok(launch.defs, "expected the agent to load");
      assert.equal(launch.defs!.model, "anthropic/test-model");
      assert.equal(launch.defs!.tools, "read,bash");
      assert.equal(launch.defs!.thinking, "high");
      assert.equal(launch.sessionMode, "lineage-only");
    });

    it("ignores an unrecognised session-mode", async () => {
      const launch = await launchOf(["session-mode: sideways"]);
      assert.equal(launch.defs!.sessionMode, undefined);
      assert.equal(launch.sessionMode, "standalone");
    });
  });

  describe("session mode drives seeding and delivery", () => {
    const cases = [
      [[], "standalone", null, false, "artifact"],
      [["session-mode: lineage-only"], "lineage-only", "lineage-only", false, "artifact"],
      [["session-mode: fork"], "fork", "fork", true, "direct"],
    ] as const;

    for (const [frontmatter, mode, seeded, inherits, delivery] of cases) {
      it(`${mode} seeds ${seeded} and delivers ${delivery}`, async () => {
        const launch = await launchOf([...frontmatter]);
        assert.equal(launch.sessionMode, mode);
        assert.equal(launch.seededSessionMode, seeded);
        assert.equal(launch.inheritsConversationContext, inherits);
        assert.equal(launch.taskDelivery, delivery);
      });
    }
  });

  describe("interactive", () => {
    it("defaults to the inverse of auto-exit", async () => {
      assert.equal((await launchOf(["auto-exit: true"])).interactive, false);
      assert.equal((await launchOf(["auto-exit: false"])).interactive, true);
      assert.equal((await launchOf([])).interactive, true, "unset auto-exit is user-driven");
    });

    it("honors an explicit interactive flag over the auto-exit default", async () => {
      assert.equal((await launchOf(["auto-exit: true", "interactive: true"])).interactive, true);
      assert.equal((await launchOf(["interactive: false"])).interactive, false);
    });

    it("reports auto-exit as resolved", async () => {
      assert.equal((await launchOf(["auto-exit: true"])).autoExit, true);
      assert.equal((await launchOf([])).autoExit, false);
    });
  });

  describe("RESUME_LAUNCH", () => {
    it("is always autonomous, because resume delivers its result and exits", () => {
      assert.deepEqual(RESUME_LAUNCH, { autoExit: true, interactive: false });
    });
  });

  describe("listAgents", () => {
    it("discovers the bundled roles", async () => {
      await withIsolatedAgentEnv(() => {
        const names = listAgents().map((a) => a.name);
        for (const expected of ["scout", "worker", "researcher"]) {
          assert.ok(names.includes(expected), `expected ${expected} in ${names.join(", ")}`);
        }
      });
    });

    it("lets a project definition shadow a global one of the same name", async () => {
      await withIsolatedAgentEnv(({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(globalAgentsDir, "dup", "name: dup\nmodel: global-model");
        writeAgentFile(projectAgentsDir, "dup", "name: dup\nmodel: project-model");

        const found = listAgents().find((a) => a.name === "dup");
        assert.equal(found?.model, "project-model");
        assert.equal(found?.source, "project");
      });
    });

    it("tags each definition with the tier it came from", async () => {
      await withIsolatedAgentEnv(() => {
        for (const agent of listAgents()) {
          assert.ok(["package", "global", "project"].includes(agent.source), agent.source);
        }
      });
    });
  });

  describe("frontmatter boolean parsing", () => {
    // Exact-match, deliberately: "True" is not "true". Pinned because a
    // refactor silently made this case-insensitive once.
    it("only accepts a lowercase true", async () => {
      assert.equal((await launchOf(["auto-exit: true"])).defs!.autoExit, true);
      assert.equal((await launchOf(["auto-exit: True"])).defs!.autoExit, false);
      assert.equal((await launchOf(["auto-exit: TRUE"])).defs!.autoExit, false);
      assert.equal((await launchOf(["auto-exit: yes"])).defs!.autoExit, false);
    });

    it("leaves the field undefined when the key is absent", async () => {
      assert.equal((await launchOf([])).defs!.autoExit, undefined);
    });
  });
});