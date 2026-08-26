import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createChildren, type RunningSubagent } from "../spawn/children.ts";
import type { SubagentLiveness } from "../observe/liveness.ts";

/**
 * The module never touches liveness — it owns the set, not the elements — so a
 * bare stub is enough and keeps these tests off the activity-file machinery.
 */
const STUB_LIVENESS = {} as SubagentLiveness;

function entry(id: string, name = id): RunningSubagent {
  return {
    id,
    name,
    task: "t",
    surface: `%${id}`,
    startTime: 0,
    sessionFile: `${id}.jsonl`,
    launchScriptFile: `${id}.sh`,
    abortController: new AbortController(),
    liveness: STUB_LIVENESS,
  };
}

/** A launch whose watcher never settles, so the entry stays live. */
function pending(id: string) {
  return {
    start: async (name: string) => entry(id, name),
    watch: () => new Promise<void>(() => {}),
  };
}

describe("children", () => {
  describe("naming", () => {
    it("uses a preferred name verbatim and never consults alsoTaken", async () => {
      const children = createChildren();
      let consulted = false;
      const running = await children.launch({
        base: "worker",
        preferred: "Scout",
        alsoTaken: () => {
          consulted = true;
          return ["Scout"];
        },
        start: async (name) => entry("a1", name),
        watch: () => new Promise<void>(() => {}),
      });

      assert.equal(running.name, "Scout");
      assert.equal(consulted, false, "a supplied name is never uniquified");
      children.shutdown();
    });

    it("derives base-2, base-3 around live names", async () => {
      const children = createChildren();
      const first = await children.launch({
        base: "worker",
        start: async (name) => entry("a1", name),
        watch: () => new Promise<void>(() => {}),
      });
      const second = await children.launch({
        base: "worker",
        start: async (name) => entry("a2", name),
        watch: () => new Promise<void>(() => {}),
      });
      const third = await children.launch({
        base: "worker",
        start: async (name) => entry("a3", name),
        watch: () => new Promise<void>(() => {}),
      });

      assert.deepEqual([first.name, second.name, third.name], ["worker", "worker-2", "worker-3"]);
      children.shutdown();
    });

    it("avoids names the caller reports as taken elsewhere", async () => {
      const children = createChildren();
      const running = await children.launch({
        base: "worker",
        alsoTaken: () => ["worker", "worker-2"],
        start: async (name) => entry("a1", name),
        watch: () => new Promise<void>(() => {}),
      });

      assert.equal(running.name, "worker-3");
      children.shutdown();
    });

    it("gives parallel launches distinct names before either registers", async () => {
      const children = createChildren();
      // Both launches run their synchronous prefix before either start resolves.
      // Without a claim held across the await they would both see an empty set.
      let releaseFirst: (() => void) | null = null;
      const firstStarted = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const a = children.launch({
        base: "worker",
        start: async (name) => {
          await firstStarted;
          return entry("a1", name);
        },
        watch: () => new Promise<void>(() => {}),
      });
      const b = children.launch({
        base: "worker",
        start: async (name) => entry("a2", name),
        watch: () => new Promise<void>(() => {}),
      });

      releaseFirst!();
      const [first, second] = await Promise.all([a, b]);
      assert.notEqual(first.name, second.name);
      assert.deepEqual([first.name, second.name].sort(), ["worker", "worker-2"]);
      children.shutdown();
    });

    it("releases the claim when start throws, so the next launch reuses the name", async () => {
      const children = createChildren();
      await assert.rejects(
        children.launch({
          base: "worker",
          start: async () => {
            throw new Error("pane died");
          },
          watch: () => new Promise<void>(() => {}),
        }),
        /pane died/,
      );

      const running = await children.launch({
        base: "worker",
        start: async (name) => entry("a1", name),
        watch: () => new Promise<void>(() => {}),
      });
      assert.equal(running.name, "worker", "the failed launch must not hold its name");
      children.shutdown();
    });
  });

  describe("membership", () => {
    it("registers before watching", async () => {
      const children = createChildren();
      let liveDuringWatch = -1;
      await children.launch({
        base: "worker",
        start: async (name) => entry("a1", name),
        watch: () => {
          liveDuringWatch = children.live().length;
          return new Promise<void>(() => {});
        },
      });

      assert.equal(liveDuringWatch, 1, "the entry must be live by the time watch is called");
      children.shutdown();
    });

    it("removes the entry when its watch settles, and reports in registration order", async () => {
      const children = createChildren();
      let finish: (() => void) | null = null;
      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      });
      await children.launch({ base: "b", ...pending("a2") });

      assert.deepEqual(
        children.live().map((r) => r.id),
        ["a1", "a2"],
      );

      finish!();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(
        children.live().map((r) => r.id),
        ["a2"],
      );
      children.shutdown();
    });

    it("removes once when a watch rejects", async () => {
      const children = createChildren();
      const seen: number[] = [];
      children.observe((live) => seen.push(live.length));
      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: async () => {
          throw new Error("watcher blew up");
        },
      });

      await new Promise((r) => setImmediate(r));
      assert.deepEqual(children.live(), []);
      assert.deepEqual(seen, [1, 0], "one registration fire, one removal fire");
      children.shutdown();
    });

    it("delivers the settled value after removal", async () => {
      const children = createChildren();
      let liveAtSettle = -1;
      let delivered: unknown = null;
      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: async () => "the result",
        settled: (child, value) => {
          liveAtSettle = children.live().length;
          delivered = value;
          assert.equal(child.id, "a1", "settled identifies its own child");
        },
      });

      await new Promise((r) => setImmediate(r));
      assert.equal(delivered, "the result");
      assert.equal(liveAtSettle, 0, "removal runs before the caller sees the result");
      children.shutdown();
    });
  });

  describe("shutdown", () => {
    it("aborts every watcher and empties the set", async () => {
      const children = createChildren();
      const a = await children.launch({ base: "a", ...pending("a1") });
      const b = await children.launch({ base: "b", ...pending("a2") });

      children.shutdown();

      assert.deepEqual(children.live(), []);
      assert.equal(a.abortController.signal.aborted, true);
      assert.equal(b.abortController.signal.aborted, true);
    });

    it("ignores a watch that settles after shutdown", async () => {
      const children = createChildren();
      let finish: (() => void) | null = null;
      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      });

      const seen: number[] = [];
      children.observe((live) => seen.push(live.length));
      children.shutdown();
      finish!();
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(seen, [], "a late settle must not fire the observer");
      assert.deepEqual(children.live(), []);
    });

    it("registers nothing for a launch still in flight when shutdown lands", async () => {
      const children = createChildren();
      let release: (() => void) | null = null;
      let watched = false;
      const inFlight = children.launch({
        base: "a",
        start: async (name) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return entry("a1", name);
        },
        watch: () => {
          watched = true;
          return new Promise<void>(() => {});
        },
      });

      children.shutdown();
      release!();
      await inFlight;

      assert.deepEqual(children.live(), []);
      assert.equal(watched, true, "the pane still needs its watcher to close it");
    });
  });

  describe("observation", () => {
    it("fires on the first registration, so there is no wait for the first paint", async () => {
      const children = createChildren();
      const seen: number[] = [];
      children.observe((live) => seen.push(live.length));
      await children.launch({ base: "a", ...pending("a1") });

      assert.deepEqual(seen, [1]);
      children.shutdown();
    });

    it("fires on every membership change, not only the empty edge", async () => {
      const children = createChildren();
      const seen: number[] = [];
      let finishA: (() => void) | null = null;
      children.observe((live) => seen.push(live.length));

      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: () =>
          new Promise<void>((resolve) => {
            finishA = resolve;
          }),
      });
      await children.launch({ base: "b", ...pending("a2") });
      finishA!();
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(seen, [1, 2, 1], "one fire per change, including a non-final completion");
      children.shutdown();
    });

    it("fires once with an empty list when the last child leaves, then stops", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const children = createChildren();
      const seen: number[] = [];
      let finish: (() => void) | null = null;
      children.observe((live) => seen.push(live.length));

      await children.launch({
        base: "a",
        start: async (name) => entry("a1", name),
        watch: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      });
      finish!();
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(seen, [1, 0]);
      t.mock.timers.tick(5000);
      assert.deepEqual(seen, [1, 0], "observation stops once the set is empty");
    });

    it("ticks about once a second while non-empty", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const children = createChildren();
      const seen: number[] = [];
      children.observe((live) => seen.push(live.length));
      await children.launch({ base: "a", ...pending("a1") });

      assert.deepEqual(seen, [1], "the registration fire");
      t.mock.timers.tick(3000);
      assert.deepEqual(seen, [1, 1, 1, 1], "three ticks");
      children.shutdown();
    });

    it("replaces the previous observer rather than adding one", async () => {
      const children = createChildren();
      const first: number[] = [];
      const second: number[] = [];
      children.observe((live) => first.push(live.length));
      children.observe((live) => second.push(live.length));
      await children.launch({ base: "a", ...pending("a1") });

      assert.deepEqual(first, [], "the replaced observer must go silent");
      assert.deepEqual(second, [1]);
      children.shutdown();
    });

    it("stops ticking after shutdown", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const children = createChildren();
      const seen: number[] = [];
      children.observe((live) => seen.push(live.length));
      await children.launch({ base: "a", ...pending("a1") });
      children.shutdown();
      const after = seen.length;

      t.mock.timers.tick(5000);
      assert.equal(seen.length, after, "shutdown stops observation");
    });
  });
});

describe("multiple sessions in one process", () => {
  it("keeps accepting launches after a session ends", async () => {
    // pi runs several sessions against one module load, and each one's
    // session_shutdown calls shutdown(). A shutdown that disabled the instance
    // for good would silently drop every spawn of every later session.
    const children = createChildren();
    await children.launch({ base: "a", ...pending("a1") });
    children.shutdown();

    const next = await children.launch({ base: "b", ...pending("a2") });

    assert.equal(next.name, "b");
    assert.deepEqual(
      children.live().map((r) => r.id),
      ["a2"],
      "a later session's subagent must be tracked, not dropped",
    );
    children.shutdown();
  });
});
