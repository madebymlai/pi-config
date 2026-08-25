import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readSubagentMessageDetails,
  renderSubagentMessage,
} from "../render/subagent-message.ts";
import type { RenderContext } from "../render/theme.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

const context = (over: Partial<RenderContext> = {}): RenderContext => ({
  theme, expandHint: () => "ctrl+o to expand", expanded: false, width: 60, ...over,
});

const DETAILS = { name: "Scout", agent: "scout", message: "which repo should I read?" };

describe("render/subagent-message.ts", () => {
  it("declines a message that is not ours", () => {
    assert.equal(readSubagentMessageDetails(null), null);
    assert.equal(readSubagentMessageDetails(42), null);
  });

  it("falls back rather than trusting the payload", () => {
    assert.deepEqual(readSubagentMessageDetails({}), {
      name: "subagent", agent: undefined, message: "",
    });
  });

  it("says the subagent is blocked, and on whom", () => {
    const body = renderSubagentMessage(DETAILS, context()).join("\n");
    assert.match(body, /Scout/);
    assert.match(body, /waiting on your reply/);
  });

  it("shows the role only when there is one", () => {
    assert.match(renderSubagentMessage(DETAILS, context()).join("\n"), /\(scout\)/);
    assert.doesNotMatch(
      renderSubagentMessage({ ...DETAILS, agent: undefined }, context()).join("\n"),
      /\(scout\)/,
    );
  });

  it("gives the reader the exact call that unblocks it", () => {
    // The name is the address, so an expanded box has to show it verbatim.
    const body = renderSubagentMessage(DETAILS, context({ expanded: true })).join("\n");
    assert.match(body, /send_message\(\{ to: "Scout"/);
  });

  it("previews only the first line when collapsed", () => {
    const body = renderSubagentMessage(
      { ...DETAILS, message: "first line\nsecond line" },
      context(),
    ).join("\n");
    assert.match(body, /first line/);
    assert.doesNotMatch(body, /second line/);
    assert.match(body, /ctrl\+o to expand/);
  });

  it("shows the whole message when expanded", () => {
    const body = renderSubagentMessage(
      { ...DETAILS, message: "first line\nsecond line" },
      context({ expanded: true }),
    ).join("\n");
    assert.match(body, /second line/);
    assert.doesNotMatch(body, /to expand/);
  });

  it("survives an empty message", () => {
    assert.ok(renderSubagentMessage({ ...DETAILS, message: "" }, context()).length > 0);
  });
});
