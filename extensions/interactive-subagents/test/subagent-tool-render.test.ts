import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSubagentCall, renderSubagentToolResult } from "../render/subagent-tool.ts";
import { formatAgentLine, NO_AGENTS_MESSAGE } from "../render/agent-list.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

const call = (args: Record<string, unknown>) => renderSubagentCall(args, theme).render(120).join("\n");

describe("render/subagent-tool.ts", () => {
  describe("the call, while the model is still writing it", () => {
    it("survives having no arguments at all", () => {
      // renderCall is redrawn on every token, so its first call sees {}.
      assert.match(call({}), /\(unnamed\)/);
    });

    it("falls back to the role when no name has arrived yet", () => {
      assert.match(call({ agent: "scout" }), /scout/);
    });

    it("shows the role separately only when the name differs from it", () => {
      assert.match(call({ agent: "scout", name: "Scout-1" }), /Scout-1 \(scout\)/);
      assert.doesNotMatch(call({ agent: "scout", name: "scout" }), /\(scout\)/);
    });

    it("mentions a working directory when one was given", () => {
      assert.match(call({ agent: "scout", name: "S", cwd: "/srv/app" }), /in \/srv\/app/);
    });

    it("previews the first non-blank line of the task", () => {
      assert.match(call({ name: "S", task: "\n\nreal first line\nsecond" }), /real first line/);
    });

    it("says how many lines the task has when it has more than one", () => {
      assert.match(call({ name: "S", task: "a\nb\nc" }), /\(3 lines\)/);
      assert.doesNotMatch(call({ name: "S", task: "just one" }), /lines\)/);
    });

    it("bounds a very long first line", () => {
      const rendered = call({ name: "S", task: "x".repeat(400) });
      assert.match(rendered, /…/);
      assert.ok(!rendered.includes("x".repeat(120)), "the preview should not run on");
    });

    it("ignores a task that is only whitespace", () => {
      assert.doesNotMatch(call({ name: "S", task: "   " }), /lines\)/);
    });
  });

  describe("the call's immediate result", () => {
    it("reports the launch, not the outcome", () => {
      // The tool returns as soon as the pane exists; the outcome arrives later.
      const text = renderSubagentToolResult({ name: "Worker", status: "started" }, "", theme)
        .render(80).join("\n");
      assert.match(text, /Worker/);
      assert.match(text, /started/);
    });

    it("falls back to the tool's own text when there is no started status", () => {
      const text = renderSubagentToolResult({ name: "W" }, "something else happened", theme)
        .render(80).join("\n");
      assert.match(text, /something else happened/);
    });

    it("survives absent details", () => {
      assert.ok(renderSubagentToolResult(null, "fallback", theme).render(80).length > 0);
    });
  });
});

describe("render/agent-list.ts", () => {
  const agent = { name: "scout", source: "package" as const, model: undefined, description: undefined };

  it("renders the same content plain and themed, differing only in the bullet", () => {
    // The two used to be separate copies, so they could drift.
    const plain = formatAgentLine({ ...agent, source: "project", model: "opus", description: "reads code" },
      { bullet: "• " });
    const themed = formatAgentLine({ ...agent, source: "project", model: "opus", description: "reads code" },
      { theme, bullet: "  " });
    assert.equal(plain.replace("• ", ""), themed.replace("  ", ""));
  });

  it("marks a project agent, because it shadows a global one by name", () => {
    assert.match(formatAgentLine({ ...agent, source: "project" }, { bullet: "• " }), /\(project\)/);
    assert.doesNotMatch(formatAgentLine(agent, { bullet: "• " }), /\(project\)/);
  });

  it("shows a model and a description only when present", () => {
    assert.equal(formatAgentLine(agent, { bullet: "• " }), "• scout");
    assert.equal(
      formatAgentLine({ ...agent, model: "opus", description: "reads code" }, { bullet: "• " }),
      "• scout [opus] — reads code",
    );
  });

  it("states the empty case once, for both renderings", () => {
    assert.match(NO_AGENTS_MESSAGE, /No subagent definitions found/);
  });
});
