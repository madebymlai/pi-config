import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  PARENT,
  registerSendMessage,
  __test__,
  type Contributor,
  type Delivery,
  type Transport,
} from "../messaging.ts";
import { createMockExtensionApi } from "./support/mock-extension-api.ts";

/** A transport that claims exactly the names it is given and records what it delivered. */
function fakeTransport(
  names: string[],
  result: Delivery | (() => never),
): Transport & { delivered: Array<[string, string]> } {
  const delivered: Array<[string, string]> = [];
  return {
    delivered,
    known: () => names,
    deliver(to, message) {
      if (!names.includes(to)) return null;
      delivered.push([to, message]);
      if (typeof result === "function") return result();
      return result;
    },
  };
}

const ctx = { sessionManager: {} } as any;

/** Theme stub: renderCall only needs fg/bold to return something printable. */
const stubTheme = { fg: (_t: string, s: string) => s, bold: (s: string) => s } as any;

function sendMessageTool(...contributions: Array<[Contributor, Transport[]]>) {
  const { api, registeredTools } = createMockExtensionApi();
  for (const [contributor, transports] of contributions) {
    registerSendMessage(api, contributor, transports);
  }
  const tool = registeredTools.find((t) => t.name === "send_message");
  assert.ok(tool, "expected send_message to be registered");
  return tool;
}

describe("messaging.ts", () => {
  beforeEach(() => __test__.resetTransports());

  describe("schema", () => {
    it("exposes exactly `to` and `message`, with only `message` required", () => {
      const tool = sendMessageTool(["children", []]);
      assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["message", "to"]);
      assert.deepEqual([...(tool.parameters.required ?? [])], ["message"]);
    });

    it("registers once per contributor, which first-wins aggregation collapses", () => {
      const { api, registeredTools } = createMockExtensionApi();
      registerSendMessage(api, "children", []);
      registerSendMessage(api, "parent", []);
      assert.equal(registeredTools.filter((t) => t.name === "send_message").length, 2);
    });
  });

  describe("routing", () => {
    it("delivers to the transport that claims the recipient", async () => {
      const children = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["children", [children]], ["parent", [parent]]);

      const out = await tool.execute(
        "c1",
        { to: "scout", message: "check auth" },
        undefined,
        undefined,
        ctx,
      );

      assert.equal(out.details.status, "steered");
      assert.deepEqual(children.delivered, [["scout", "check auth"]]);
      assert.deepEqual(parent.delivered, []);
    });

    it("routes `parent` upward even when children are addressable", async () => {
      const children = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["children", [children]], ["parent", [parent]]);

      const out = await tool.execute(
        "c1",
        { to: PARENT, message: "which base url?" },
        undefined,
        undefined,
        ctx,
      );

      assert.equal(out.details.status, "sent-to-parent");
      assert.deepEqual(parent.delivered, [[PARENT, "which base url?"]]);
      assert.deepEqual(children.delivered, []);
    });

    it("prefers the earlier transport when two claim the same name", async () => {
      const steer = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const resume = fakeTransport(["scout"], {
        status: "resumed",
        name: "scout",
        sessionId: "s1",
      });
      const tool = sendMessageTool(["children", [steer, resume]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "steered");
      assert.deepEqual(resume.delivered, []);
    });

    it("falls through to a later transport when the earlier one passes", async () => {
      const steer = fakeTransport([], { status: "steered", name: "scout" });
      const resume = fakeTransport(["scout"], {
        status: "resumed",
        name: "scout",
        sessionId: "s1",
      });
      const tool = sendMessageTool(["children", [steer, resume]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "resumed");
    });
  });

  describe("the reserved parent name", () => {
    it("is never offered to a child transport, even one that claims it", async () => {
      // A registry written before the name was reserved can still hold a
      // subagent called "parent". Refusing the name at spawn time cannot undo
      // that, so routing itself must keep the name for the parent transport.
      const impostor = fakeTransport([PARENT], { status: "resumed", name: PARENT, sessionId: "s1" });
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["children", [impostor]], ["parent", [parent]]);

      const out = await tool.execute("c1", { to: PARENT, message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "sent-to-parent");
      assert.deepEqual(impostor.delivered, [], "a child transport must not serve the reserved name");
    });

    it("reports no-parent rather than falling back to a child transport", async () => {
      const impostor = fakeTransport([PARENT], { status: "steered", name: PARENT });
      const tool = sendMessageTool(["children", [impostor]]);

      const out = await tool.execute("c1", { to: PARENT, message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "no-parent");
      assert.deepEqual(impostor.delivered, []);
    });
  });

  describe("failures are results, never throws", () => {
    it("reports an unknown recipient with the names that do exist", async () => {
      const children = fakeTransport(["scout", "worker"], { status: "steered", name: "scout" });
      const tool = sendMessageTool(["children", [children]]);

      const out = await tool.execute("c1", { to: "typo", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "unknown-target");
      assert.deepEqual(out.details.known, ["scout", "worker"]);
      assert.match(out.content[0].text, /scout/);
      assert.match(out.content[0].text, /worker/);
    });

    it("says so when nothing is addressable yet", async () => {
      const tool = sendMessageTool(["children", [fakeTransport([], { status: "sent-to-parent" })]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "unknown-target");
      assert.deepEqual(out.details.known, []);
    });

    it("distinguishes having no parent from an unknown name", async () => {
      const tool = sendMessageTool([
        "children",
        [fakeTransport(["scout"], { status: "steered", name: "scout" })],
      ]);

      const out = await tool.execute("c1", { to: PARENT, message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "no-parent");
    });

    it("turns a throwing transport into transport-failed", async () => {
      const boom = fakeTransport(["scout"], () => {
        throw new Error("tmux server not running");
      });
      const tool = sendMessageTool(["children", [boom]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "transport-failed");
      assert.match(out.details.reason, /tmux server not running/);
    });

    it("turns a rejecting transport into transport-failed", async () => {
      const tool = sendMessageTool([
        "children",
        [{ known: () => ["scout"], deliver: () => Promise.reject(new Error("pane died")) }],
      ]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "transport-failed");
      assert.match(out.details.reason, /pane died/);
    });

    it("keeps asking the remaining transports after one throws", async () => {
      // A throwing transport never said the recipient was its own, so it must
      // not be able to make every other recipient unreachable.
      const broken: Transport = {
        known: () => ["scout"],
        deliver() {
          throw new Error("corrupt registry");
        },
      };
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["children", [broken]], ["parent", [parent]]);

      const reached = await tool.execute("c1", { to: "anything", message: "hi" }, undefined, undefined, ctx);
      assert.equal(reached.details.status, "transport-failed", "nothing else claimed it, so report the throw");
      assert.match(reached.details.reason, /corrupt registry/);
    });

    it("still reaches a later transport that claims the recipient after an earlier throw", async () => {
      const broken: Transport = {
        known: () => [],
        deliver() {
          throw new Error("corrupt registry");
        },
      };
      const good = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const tool = sendMessageTool(["children", [broken, good]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "steered");
      assert.deepEqual(good.delivered, [["scout", "hi"]]);
    });

    it("still explains an unknown recipient when a transport cannot list its names", async () => {
      const broken: Transport = {
        known: () => {
          throw new Error("registry unreadable");
        },
        deliver: () => null,
      };
      const good = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const tool = sendMessageTool(["children", [broken, good]]);

      const out = await tool.execute("c1", { to: "typo", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "unknown-target");
      assert.deepEqual(out.details.known, ["scout"]);
    });

    it("routes a blank recipient to the parent and rejects a blank message", async () => {
      const children = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const tool = sendMessageTool(["children", [children]]);

      const blankTo = await tool.execute("c1", { to: "  ", message: "hi" }, undefined, undefined, ctx);
      const blankMsg = await tool.execute(
        "c2",
        { to: "scout", message: "  " },
        undefined,
        undefined,
        ctx,
      );

      assert.equal(blankTo.details.status, "no-default-recipient");
      assert.equal(blankMsg.details.status, "empty-message");
      assert.deepEqual(children.delivered, []);
    });
  });

  describe("contributor slots", () => {
    it("replaces a contributor's transports on re-registration rather than accumulating", async () => {
      const stale = fakeTransport(["scout"], { status: "steered", name: "stale" });
      const fresh = fakeTransport(["scout"], { status: "steered", name: "fresh" });

      sendMessageTool(["children", [stale]]);
      const tool = sendMessageTool(["children", [fresh]]);

      const out = await tool.execute("c1", { to: "scout", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.name, "fresh");
      assert.deepEqual(stale.delivered, []);
    });

    it("lets a second contributor add reach without displacing the first", async () => {
      const children = fakeTransport(["scout"], { status: "steered", name: "scout" });
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });

      sendMessageTool(["children", [children]]);
      const tool = sendMessageTool(["parent", [parent]]);

      assert.equal(
        (await tool.execute("c1", { to: "scout", message: "a" }, undefined, undefined, ctx)).details
          .status,
        "steered",
      );
      assert.equal(
        (await tool.execute("c2", { to: PARENT, message: "b" }, undefined, undefined, ctx)).details
          .status,
        "sent-to-parent",
      );
    });
  });

  describe("rendering", () => {
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

    it("renders a partial call without throwing", () => {
      const tool = sendMessageTool(["children", []]);
      // No recipient named: the call renders against where it will actually go.
      const output = tool.renderCall({}, theme).render(80).join("\n");
      assert.match(output, new RegExp(PARENT));
    });

    it("renders every delivery outcome distinguishably", () => {
      const tool = sendMessageTool(["children", []]);
      const outcomes: Delivery[] = [
        { status: "steered", name: "scout" },
        { status: "resumed", name: "scout", sessionId: "s1" },
        { status: "sent-to-parent" },
        { status: "no-parent" },
        { status: "unknown-target", known: ["scout"] },
        { status: "empty-message" },
        { status: "unresumable", reason: "no loadout snapshot" },
        { status: "transport-failed", reason: "tmux gone" },
      ];

      const rendered = outcomes.map((details) =>
        tool
          .renderResult({ content: [{ type: "text", text: "" }], details }, {}, theme, {})
          .render(80)
          .join("\n"),
      );

      assert.equal(
        new Set(rendered).size,
        outcomes.length,
        "each outcome should render differently",
      );
      for (const line of rendered) assert.ok(line.trim().length > 0);
    });
  });

  describe("omitting `to`", () => {
    // A leaf subagent only ever messages upward, so making it name the parent
    // every time is ceremony. Omitting `to` means "the agent that spawned me".
    it("routes to the parent when `to` is omitted", async () => {
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["parent", [parent]]);

      const out = await tool.execute("c", { message: "which base url?" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "sent-to-parent");
      assert.deepEqual(parent.delivered, [[PARENT, "which base url?"]]);
    });

    it("treats a blank `to` the same as omitting it", async () => {
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const tool = sendMessageTool(["parent", [parent]]);

      const out = await tool.execute("c", { to: "   ", message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "sent-to-parent");
      assert.deepEqual(parent.delivered, [[PARENT, "hi"]]);
    });

    it("still prefers an explicit recipient over the default", async () => {
      const parent = fakeTransport([PARENT], { status: "sent-to-parent" });
      const child = fakeTransport(["scout-1"], { status: "steered", name: "scout-1" });
      const tool = sendMessageTool(["parent", [parent]], ["children", [child]]);

      const out = await tool.execute("c", { to: "scout-1", message: "go" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "steered");
      assert.deepEqual(parent.delivered, [], "the default must not shadow an explicit name");
    });

    it("tells a top-level session who it could address instead", async () => {
      // No parent transport: this session spawned everything and answers to nobody.
      const child = fakeTransport(["scout-1", "worker-2"], { status: "steered", name: "scout-1" });
      const tool = sendMessageTool(["children", [child]]);

      const out = await tool.execute("c", { message: "hello?" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "no-default-recipient");
      assert.deepEqual(out.details.known, ["scout-1", "worker-2"]);
      assert.match(out.content[0].text, /scout-1, worker-2/);
    });

    it("distinguishes omitting `to` from explicitly addressing an absent parent", async () => {
      const child = fakeTransport(["scout-1"], { status: "steered", name: "scout-1" });
      const tool = sendMessageTool(["children", [child]]);

      const omitted = await tool.execute("c", { message: "x" }, undefined, undefined, ctx);
      const explicit = await tool.execute("c", { to: PARENT, message: "x" }, undefined, undefined, ctx);

      assert.equal(omitted.details.status, "no-default-recipient");
      assert.equal(explicit.details.status, "no-parent");
    });

    it("reports an empty message before worrying about the recipient", async () => {
      const tool = sendMessageTool(["children", []]);
      const out = await tool.execute("c", { message: "  " }, undefined, undefined, ctx);
      assert.equal(out.details.status, "empty-message");
    });

    it("renders the call against the parent when no recipient is named", () => {
      const tool = sendMessageTool(["parent", []]);
      const rendered = tool.renderCall({ message: "hi" }, stubTheme).render(80).join("\n");
      assert.match(rendered, new RegExp(PARENT));
    });
  });
});