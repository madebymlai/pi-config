import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStatusDigest } from "../render/status.ts";

/**
 * The digest is one call because its two outputs have to agree.
 *
 * index.ts used to build the status message from two: capStatusLines for the
 * details and formatStatusAggregate for the content, passing the same limit to
 * both and trusting them to cap the same way. Nothing enforced that, and a
 * divergence would have shown the user a box listing different subagents than
 * the text beside it.
 */
describe("renderStatusDigest", () => {
  const lines = ["Worker running 5m.", "Scout running 3m.", "Reviewer running 2m."];

  it("returns the visible lines the content is built from", () => {
    const digest = renderStatusDigest(lines, 2);

    assert.deepEqual(digest.visibleLines, ["Worker running 5m.", "Scout running 3m."]);
    for (const line of digest.visibleLines) {
      assert.ok(digest.content.includes(line), `content omits a line it reports as visible: ${line}`);
    }
    assert.ok(!digest.content.includes("Reviewer"), "content shows a line it reports as hidden");
  });

  it("counts what it left out, and says so in the content", () => {
    const digest = renderStatusDigest(lines, 1);

    assert.equal(digest.overflow, 2);
    assert.match(digest.content, /\+2 more running\./);
  });

  it("reports no overflow when everything fits", () => {
    const digest = renderStatusDigest(lines, 10);

    assert.equal(digest.overflow, 0);
    assert.deepEqual(digest.visibleLines, lines);
    assert.doesNotMatch(digest.content, /more running/);
  });

  it("survives a limit of zero", () => {
    const digest = renderStatusDigest(lines, 0);

    assert.deepEqual(digest.visibleLines, []);
    assert.equal(digest.overflow, 3);
    assert.match(digest.content, /\+3 more running\./);
  });

  it("titles the digest so a steer reads as status, not as output", () => {
    assert.match(renderStatusDigest(lines, 4).content, /^Subagent status:/);
  });
});
