import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refuseSpawn, describeRefusal, type SpawnEnvironment } from "../spawn-guard.ts";

const ENV: SpawnEnvironment = {
  currentAgent: undefined,
  permitted: () => ["scout", "worker"],
  restricted: false,
  muxAvailable: () => true,
  hasSessionFile: () => true,
  muxUnavailableMessage: () => "tmux is required. install it.",
};

const env = (over: Partial<SpawnEnvironment> = {}): SpawnEnvironment => ({ ...ENV, ...over });

describe("spawn-guard.ts", () => {
  describe("a permissible spawn", () => {
    it("is not refused", () => {
      assert.equal(refuseSpawn({ agent: "scout" }, env()), null);
    });

    it("is not refused for a name that merely contains the reserved word", () => {
      assert.equal(refuseSpawn({ agent: "scout", name: "parental" }, env()), null);
    });
  });

  describe("refusals", () => {
    it("blocks an agent from spawning itself", () => {
      const r = refuseSpawn({ agent: "worker" }, env({ currentAgent: "worker" }));
      assert.equal(r?.status, "self-spawn");
    });

    it("allows an agent to spawn a different agent", () => {
      assert.equal(refuseSpawn({ agent: "scout" }, env({ currentAgent: "worker" })), null);
    });

    it("requires an agent to be named", () => {
      const r = refuseSpawn({}, env());
      assert.equal(r?.status, "agent-required");
    });

    it("treats a whitespace-only agent as unknown, not as missing", () => {
      assert.equal(refuseSpawn({ agent: "   " }, env())?.status, "unknown-agent");
    });

    // Regression: trimming here once passed the whitelist while leaving the
    // padded name to be looked up downstream, which found no role file and so
    // launched an unrestricted, full-toolset child.
    it("refuses a permitted agent whose name is padded", () => {
      for (const padded of [" scout", "scout ", " scout ", "scout\t"]) {
        assert.equal(
          refuseSpawn({ agent: padded }, env())?.status,
          "unknown-agent",
          `${JSON.stringify(padded)} must not pass the whitelist`,
        );
      }
    });

    it("rejects an agent outside the permitted set", () => {
      const r = refuseSpawn({ agent: "nope" }, env());
      assert.equal(r?.status, "unknown-agent");
    });

    it("rejects the reserved parent name", () => {
      assert.equal(refuseSpawn({ agent: "scout", name: "parent" }, env())?.status, "reserved-name");
    });

    it("rejects the reserved name even when padded", () => {
      assert.equal(refuseSpawn({ agent: "scout", name: "  parent  " }, env())?.status, "reserved-name");
    });

    it("refuses when the multiplexer is unavailable", () => {
      assert.equal(refuseSpawn({ agent: "scout" }, env({ muxAvailable: () => false }))?.status, "no-mux");
    });

    it("refuses without a session file", () => {
      assert.equal(
        refuseSpawn({ agent: "scout" }, env({ hasSessionFile: () => false }))?.status,
        "no-session-file",
      );
    });
  });

  describe("guard order", () => {
    // The order is policy: a self-spawn is reported as a self-spawn even when
    // the environment is also broken, so the caller sees the most specific
    // reason rather than whichever check happened to run first.
    it("reports self-spawn ahead of everything else", () => {
      const r = refuseSpawn(
        { agent: "worker", name: "parent" },
        env({ currentAgent: "worker", muxAvailable: () => false, hasSessionFile: () => false }),
      );
      assert.equal(r?.status, "self-spawn");
    });

    it("reports a missing agent ahead of a reserved name", () => {
      assert.equal(refuseSpawn({ name: "parent" }, env())?.status, "agent-required");
    });

    it("reports an unknown agent ahead of a reserved name", () => {
      assert.equal(refuseSpawn({ agent: "nope", name: "parent" }, env())?.status, "unknown-agent");
    });

    it("reports a reserved name ahead of a missing multiplexer", () => {
      assert.equal(
        refuseSpawn({ agent: "scout", name: "parent" }, env({ muxAvailable: () => false }))?.status,
        "reserved-name",
      );
    });

    it("reports a missing multiplexer ahead of a missing session file", () => {
      assert.equal(
        refuseSpawn({ agent: "scout" }, env({ muxAvailable: () => false, hasSessionFile: () => false }))?.status,
        "no-mux",
      );
    });
  });

  describe("describeRefusal", () => {
    it("names the agent in a self-spawn refusal", () => {
      const { text, error } = describeRefusal({ status: "self-spawn", agent: "worker" });
      assert.match(text, /worker/);
      assert.equal(error, "self-spawn blocked");
    });

    it("lists what may be spawned when none was named", () => {
      const { text, error } = describeRefusal({
        status: "agent-required",
        permitted: ["scout", "worker"],
      });
      assert.match(text, /scout, worker/);
      assert.equal(error, "agent required");
    });

    it("says (none) when nothing may be spawned", () => {
      const { text } = describeRefusal({ status: "agent-required", permitted: [] });
      assert.match(text, /\(none\)/);
    });

    it("distinguishes an allowlist miss from an unknown agent", () => {
      const restricted = describeRefusal({
        status: "not-in-allowlist",
        agent: "x",
        permitted: ["scout"],
      });
      assert.match(restricted.text, /in your allowlist/);
      assert.equal(restricted.error, "agent not in allowlist");

      const unknown = describeRefusal({ status: "unknown-agent", agent: "x", permitted: ["scout"] });
      assert.match(unknown.text, /a known agent/);
      assert.equal(unknown.error, "unknown agent");
    });

    it("picks the allowlist variant only when the session is restricted", () => {
      const pinned = refuseSpawn({ agent: "nope" }, env({ restricted: true }));
      assert.equal(pinned?.status, "not-in-allowlist");
      assert.equal(refuseSpawn({ agent: "nope" }, env({ restricted: false }))?.status, "unknown-agent");
    });

    it("explains why parent is reserved", () => {
      const { text, error } = describeRefusal({ status: "reserved-name" });
      assert.match(text, /send_message/);
      assert.equal(error, "reserved name");
    });

    it("quotes the multiplexer message verbatim", () => {
      const { text, error } = describeRefusal({ status: "no-mux", message: "needs tmux; install it" });
      assert.equal(text, "needs tmux; install it");
      assert.equal(error, "tmux not available");
    });

    it("describes a missing session file", () => {
      const { text, error } = describeRefusal({ status: "no-session-file" });
      assert.match(text, /session/i);
      assert.equal(error, "no session file");
    });
  });

  describe("laziness", () => {
    // A malformed request must not need a working environment to be refused,
    // so it can never fail for an unrelated reason.
    it("refuses a missing agent without touching the environment", () => {
      let touched = 0;
      const count = <T,>(v: T) => () => { touched++; return v; };
      refuseSpawn({}, {
        currentAgent: undefined,
        permitted: () => ["scout"],
        restricted: false,
        muxAvailable: count(true),
        hasSessionFile: count(true),
        muxUnavailableMessage: count("hint"),
      });
      assert.equal(touched, 0, "environment was probed for an invalid request");
    });

    it("does not discover agents to refuse a self-spawn", () => {
      let discovered = 0;
      refuseSpawn({ agent: "worker" }, {
        ...ENV,
        currentAgent: "worker",
        permitted: () => { discovered++; return ["worker"]; },
      });
      assert.equal(discovered, 0, "agents were discovered for a self-spawn refusal");
    });
  });
});
