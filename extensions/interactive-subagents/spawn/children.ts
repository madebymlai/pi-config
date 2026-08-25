/**
 * Who is live, what they are called, and who is watching them.
 *
 * Not a supervisor: in OTP that word means restarting children under a restart
 * strategy, and nothing here ever restarts anything. Not a nursery or task
 * group either — those do not exit until their children finish, whereas the
 * `subagent` tool returns while its child keeps running. What this does to a
 * child is `monitor` in Erlang's strict sense: observe, report on termination,
 * never revive. "Registry" was unavailable: `store/name-registry.ts` owns that
 * word for the durable name->session map, which outlives any process.
 *
 * The set's emptiness is what starts and stops observation, and observation
 * exists only to read the set, so they are one module rather than two. A name
 * claim exists only because registration is awaited: parallel `subagent` calls
 * run their synchronous prefix before any of them registers, so without a claim
 * held across the await they would all see an empty set and pick one name.
 *
 * `launch` is one uninterruptible sequence — claim, start, register, watch,
 * remove — because every ordering bug this module exists to prevent came from a
 * caller holding the intermediate state. Callers never receive it.
 */
import type { SubagentLiveness } from "../observe/liveness.ts";

/** State for a launched (but not yet completed) subagent. */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** The generated shell script, kept so a launch can be inspected after the fact. */
  launchScriptFile: string;
  /** Aborts the watcher; the tool call's own signal is long gone by then. */
  abortController: AbortController;
  /** How it is doing. The activity file and the status state live behind this. */
  liveness: SubagentLiveness;
}

export interface LaunchRequest<T> {
  /** Name to derive from when none is supplied. */
  base: string;
  /**
   * Used verbatim when given. Names are therefore NOT unique — a caller may
   * supply one that collides — which is why routing reports ambiguity rather
   * than assuming a name resolves to one child.
   */
  preferred?: string;
  /** Consulted only when a name must be derived, so a named launch pays nothing. */
  alsoTaken?: () => Iterable<string>;
  /** Sends the command and builds the entry. Must NOT watch it. */
  start: (name: string) => Promise<RunningSubagent>;
  /**
   * Observes the entry to completion. The entry's lifetime is exactly this
   * promise's pending window, so one that never settles leaves an entry only
   * `shutdown` can remove.
   */
  watch: (running: RunningSubagent) => Promise<T>;
  /** Called after the entry is removed, so it never sees its own child live. */
  settled?: (running: RunningSubagent, value: T | undefined, error: unknown) => void;
}

export interface Children {
  /**
   * Register a child under a free name and watch it to completion.
   *
   * The claim is released as soon as the entry registers, since the entry then
   * covers the name. Registration is synchronous on `start`'s result and
   * precedes watching. Removal is at-most-once: a watch settling after
   * `shutdown` already removed the entry does nothing.
   *
   * Rejects with whatever `start` rejects with, having released the claim.
   * After `shutdown`, nothing registers — but `watch` still runs, because the
   * pane it is holding still needs closing.
   */
  launch<T>(request: LaunchRequest<T>): Promise<RunningSubagent>;

  /** Everything currently live, in registration order. */
  live(): readonly RunningSubagent[];

  /**
   * Observe the live set. Fires on every membership change — including the
   * first registration, so nothing waits a tick for its first paint — and about
   * once a second while non-empty. The final fire carries an empty list, after
   * which observation stops. Re-calling replaces the previous observer, which
   * is what makes `/reload` safe: the reloaded module rebinds, and the dead
   * load's closure stops being called.
   */
  observe(onTick: (live: readonly RunningSubagent[], now: number) => void): void;

  /** Abort every watcher, empty the set, stop observing. */
  shutdown(): void;
}

const TICK_MS = 1000;

/**
 * Survive /reload: the timer handle, and only the timer handle, lives on a
 * process-global slot. /reload re-imports this file and builds a fresh set —
 * which is correct, the old load's entries belong to the old load — but the old
 * load's interval keeps firing until something clears it, and only a global can
 * carry that handle across the module boundary.
 */
const TIMER_KEY = Symbol.for("pi-subagents/children-interval");

type Timer = ReturnType<typeof setInterval>;

function globals() {
  return globalThis as Record<symbol, Timer | null | undefined>;
}

{
  const previous = globals()[TIMER_KEY];
  if (previous) {
    clearInterval(previous);
    globals()[TIMER_KEY] = null;
  }
}

export function createChildren(): Children {
  const entries = new Map<string, RunningSubagent>();
  /** Names claimed by launches that are mid-start and not yet registered. */
  const claims = new Set<string>();
  let observer: ((live: readonly RunningSubagent[], now: number) => void) | null = null;
  let timer: Timer | null = null;
  let closed = false;

  function snapshot() {
    return Array.from(entries.values());
  }

  function startTicking() {
    if (timer) return;
    timer = setInterval(() => observer?.(snapshot(), Date.now()), TICK_MS);
    // Nothing should hold the process open just to watch an empty pane.
    timer.unref?.();
    globals()[TIMER_KEY] = timer;
  }

  function stopTicking() {
    if (!timer) return;
    clearInterval(timer);
    if (globals()[TIMER_KEY] === timer) globals()[TIMER_KEY] = null;
    timer = null;
  }

  /** One fire per membership change; the last one carries an empty list. */
  function changed() {
    if (entries.size === 0) stopTicking();
    else startTicking();
    observer?.(snapshot(), Date.now());
  }

  function derive(base: string, alsoTaken?: () => Iterable<string>) {
    const taken = new Set<string>();
    for (const running of entries.values()) taken.add(running.name);
    for (const claim of claims) taken.add(claim);
    if (alsoTaken) for (const name of alsoTaken()) taken.add(name);

    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  return {
    async launch<T>(request: LaunchRequest<T>) {
      const preferred = request.preferred?.trim() ? request.preferred : undefined;
      const name = preferred ?? derive(request.base, request.alsoTaken);
      // Only a derived name needs a claim: a supplied one was never ours to hand out.
      const claimed = preferred === undefined;
      if (claimed) claims.add(name);

      let running: RunningSubagent;
      try {
        running = await request.start(name);
      } finally {
        if (claimed) claims.delete(name);
      }

      // Shut down mid-launch: register nothing and stay silent, but still watch.
      // The watcher is what closes the pane this launch just opened.
      if (closed) {
        void request.watch(running).catch(() => {});
        return running;
      }

      entries.set(running.id, running);
      changed();

      let removed = false;
      const remove = () => {
        if (removed) return false;
        removed = true;
        // Absent when shutdown got there first — then there is nothing to
        // announce, and nothing that should re-arm the interval.
        return entries.delete(running.id) ? (changed(), true) : false;
      };

      request.watch(running).then(
        (value) => {
          remove();
          request.settled?.(running, value, null);
        },
        (error) => {
          remove();
          request.settled?.(running, undefined, error);
        },
      );

      return running;
    },

    live() {
      return snapshot();
    },

    observe(onTick) {
      observer = onTick;
    },

    shutdown() {
      closed = true;
      stopTicking();
      observer = null;
      for (const running of entries.values()) running.abortController.abort();
      entries.clear();
    },
  };
}
