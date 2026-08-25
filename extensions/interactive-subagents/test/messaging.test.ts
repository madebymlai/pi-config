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
    it("exposes exactly `to` and `message`, both required", () => {
      const tool = sendMessageTool(["children", []]);
      assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["message", "to"]);
      assert.deepEqual([...(tool.parameters.required ?? [])].sort(), ["message", "to"]);
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
      const parent = fakeTransport([PARENT], { status: "asked" });
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
      const parent = fakeTransport([PARENT], { status: "asked" });
      const tool = sendMessageTool(["children", [children]], ["parent", [parent]]);

      const out = await tool.execute(
        "c1",
        { to: PARENT, message: "which base url?" },
        undefined,
        undefined,
        ctx,
      );

      assert.equal(out.details.status, "asked");
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
      const parent = fakeTransport([PARENT], { status: "asked" });
      const tool = sendMessageTool(["children", [impostor]], ["parent", [parent]]);

      const out = await tool.execute("c1", { to: PARENT, message: "hi" }, undefined, undefined, ctx);

      assert.equal(out.details.status, "asked");
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
      const tool = sendMessageTool(["children", [fakeTransport([], { status: "asked" })]]);

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
      const parent = fakeTransport([PARENT], { status: "asked" });
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

    it("rejects a blank recipient and a blank message without consulting transports", async () => {
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

      assert.equal(blankTo.details.status, "unknown-target");
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
      const parent = fakeTransport([PARENT], { status: "asked" });

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
        "asked",
      );
    });
  });

  describe("rendering", () => {
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

    it("renders a partial call without throwing", () => {
      const tool = sendMessageTool(["children", []]);
      const output = tool.renderCall({}, theme).render(80).join("\n");
      assert.match(output, /\(unknown\)/);
    });

    it("renders every delivery outcome distinguishably", () => {
      const tool = sendMessageTool(["children", []]);
      const outcomes: Delivery[] = [
        { status: "steered", name: "scout" },
        { status: "resumed", name: "scout", sessionId: "s1" },
        { status: "asked" },
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
});
