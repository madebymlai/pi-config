/**
 * send_message — one tool for talking to any agent in this lineage.
 *
 * Replaces the old split between `subagent_message` (downward, by name) and
 * `ask_question` (upward, implicit). Neither could be documented without the
 * other — `ask_question` had to tell the reader that replies arrive "via
 * subagent_message" — and a spawning worker held both at once, picking between
 * them purely on direction of travel.
 *
 * Recipients are display names, the same ones the widget shows. `parent` is a
 * reserved name in that namespace, so addressing upward is the same act as
 * addressing sideways rather than a second concept.
 *
 * How a message physically travels is a `Transport`. Transports are supplied at
 * registration rather than reached for here, so routing, name resolution and
 * outcome mapping can be exercised without tmux and without a live pi process.
 *
 * Two things about pi's extension loader shape this module:
 *
 *   1. Each extension file gets its OWN ExtensionAPI, so a spawning worker —
 *      which loads index.ts and subagent-done.ts in one process — has two
 *      registrars and needs one tool spanning both. Transports therefore live
 *      in a process-global hub keyed per contributor, the same mechanism this
 *      extension already uses for the running-children count.
 *   2. Tool aggregation is "first registration per name wins", with no error on
 *      duplicates. Both registrars may safely register; whichever pi honours,
 *      it reads the same hub and reaches the union.
 *
 * Keying the hub per contributor rather than appending is what makes /reload
 * safe: a reloaded extension overwrites its own slot instead of stacking a
 * second copy of its transports behind the stale ones.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

/** The reserved recipient name for the agent that spawned this one. */
export const PARENT = "parent";

/** What a transport needs from the tool call it is delivering inside. */
export type MessagingContext = Pick<ExtensionContext, "sessionManager">;

type MaybePromise<T> = T | Promise<T>;

/**
 * Every way a delivery can end. Closed on purpose: the renderer switches on it,
 * so a new outcome surfaces as a type error rather than as unhandled prose.
 */
export type Delivery =
  | { status: "steered"; name: string }
  | { status: "resumed"; name: string; sessionId: string }
  | { status: "asked" }
  | { status: "no-parent" }
  | { status: "unknown-target"; known: string[] }
  | { status: "empty-message" }
  | { status: "unresumable"; reason: string }
  | { status: "transport-failed"; reason: string };

export interface Transport {
  /** Recipients this transport can reach right now. Used only to explain an unknown name. */
  known(): string[];
  /**
   * Deliver to `to`, or return null to pass — null means "not a recipient I
   * serve", never "I tried and failed". A transport that owns the name but
   * cannot deliver returns a failing Delivery so the reason reaches the caller.
   */
  deliver(to: string, message: string, ctx: MessagingContext): MaybePromise<Delivery | null>;
}

/**
 * Who contributed a set of transports. The order here is the routing order: a
 * name that a child transport claims is never offered to the parent transport.
 */
const CONTRIBUTORS = ["children", "parent"] as const;
export type Contributor = (typeof CONTRIBUTORS)[number];

const HUB_KEY = Symbol.for("pi-subagents/message-transports");

function hub(): Map<Contributor, Transport[]> {
  const globals = globalThis as Record<symbol, unknown>;
  let existing = globals[HUB_KEY] as Map<Contributor, Transport[]> | undefined;
  if (!existing) {
    existing = new Map();
    globals[HUB_KEY] = existing;
  }
  return existing;
}

function activeTransports(): Transport[] {
  return CONTRIBUTORS.flatMap((contributor) => hub().get(contributor) ?? []);
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "(no detail)";
}

/** Ask each transport in turn; the first to claim the recipient decides the outcome. */
async function route(to: string, message: string, ctx: MessagingContext): Promise<Delivery> {
  const transports = activeTransports();

  for (const transport of transports) {
    try {
      const delivery = await transport.deliver(to, message, ctx);
      if (delivery) return delivery;
    } catch (error) {
      return { status: "transport-failed", reason: reasonOf(error) };
    }
  }

  // Nothing claimed it. Addressing a parent you do not have is a different
  // mistake from naming a subagent that does not exist, so it reads differently.
  if (to === PARENT) return { status: "no-parent" };

  const known: string[] = [];
  for (const transport of transports) {
    for (const name of transport.known()) if (!known.includes(name)) known.push(name);
  }
  return { status: "unknown-target", known };
}

/** The text the calling agent reads, and whether it should read as a failure. */
function present(delivery: Delivery): { text: string; failed: boolean } {
  switch (delivery.status) {
    case "steered":
      return {
        failed: false,
        text:
          `Message delivered to running subagent "${delivery.name}". It picks this up at its next ` +
          `turn boundary. If it exits, its result still arrives as a steer message.`,
      };
    case "resumed":
      return {
        failed: false,
        text:
          `Session "${delivery.name}" resumed. This is fire-and-forget: when it finishes, its ` +
          `result is delivered to you automatically. Do not poll, sleep, or read session files.`,
      };
    case "asked":
      return {
        failed: false,
        text:
          "Message sent to the orchestrator. Stop here and wait — do not continue working or " +
          "assume an answer. Their reply will arrive as your next message.",
      };
    case "no-parent":
      return {
        failed: true,
        text:
          `You are the top-level session, so there is no "${PARENT}" to message. ` +
          `Address a subagent by name instead.`,
      };
    case "unknown-target":
      return {
        failed: true,
        text:
          delivery.known.length > 0
            ? `No recipient named that in this session. Known recipients: ${delivery.known.join(", ")}.`
            : "No recipient named that in this session, and nothing is addressable yet.",
      };
    case "empty-message":
      return { failed: true, text: "`message` is required — there is nothing to deliver." };
    case "unresumable":
      return { failed: true, text: delivery.reason };
    case "transport-failed":
      return { failed: true, text: `Delivery failed: ${delivery.reason}` };
  }
}

function icon(delivery: Delivery, theme: any): string {
  switch (delivery.status) {
    case "steered":
      return theme.fg("success", "✓");
    case "resumed":
      return theme.fg("accent", "⟳");
    case "asked":
      return theme.fg("accent", "?");
    default:
      return theme.fg("error", "✗");
  }
}

/** The short line shown beside the icon — what happened, not the whole result. */
function summarize(delivery: Delivery): string {
  switch (delivery.status) {
    case "steered":
      return `${delivery.name} — message delivered`;
    case "resumed":
      return `${delivery.name} — resumed`;
    case "asked":
      return "orchestrator — question sent";
    case "no-parent":
      return "no parent to message";
    case "unknown-target":
      return "unknown recipient";
    case "empty-message":
      return "empty message";
    case "unresumable":
      return `cannot resume — ${delivery.reason}`;
    case "transport-failed":
      return `delivery failed — ${delivery.reason}`;
  }
}

/**
 * Contribute `transports` and register the tool.
 *
 * Safe to call from more than one extension in the same process: the hub slot
 * for `contributor` is replaced, and pi keeps the first tool registration.
 */
export function registerSendMessage(
  pi: ExtensionAPI,
  contributor: Contributor,
  transports: Transport[],
): void {
  hub().set(contributor, transports);

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to another agent in this session, addressed by display name. " +
      `Use "${PARENT}" to reach the agent that spawned you; use a subagent's name to reach it. ` +
      "Names are unique within your session and persist after a subagent finishes, so the SAME name " +
      "works whether it is running or finished: a running subagent is steered mid-task, a finished one " +
      "is resumed and continued. " +
      "Every form returns immediately. Steering acknowledges locally and does not, by itself, produce a " +
      "new result. Resuming is fire-and-forget: when the resumed session finishes, the harness " +
      "AUTOMATICALLY delivers its result as a steer message that wakes you up. Messaging the parent keeps " +
      "your session open and their reply arrives as your next message. " +
      "DO NOT poll, sleep, tail logs, or read session files to detect a reply — the harness handles delivery. " +
      "DO NOT fabricate or assume a reply. After calling, either wait or work on other independent tasks.",
    promptSnippet:
      `Message another agent by name — "${PARENT}" for the one that spawned you, or a subagent's name ` +
      "(steers it if running, resumes it if finished). Both `to` and `message` are required. " +
      "Never poll for a reply and never fabricate one.",
    promptGuidelines: [
      `Address the agent that spawned you as "${PARENT}". Every other recipient is a subagent's display name.`,
      "Always name the recipient explicitly. There is no default, so a message can never reach the wrong agent silently.",
      "Ask one thing per message. Make separate calls for unrelated questions.",
      "Give enough context that the recipient can act without re-reading your whole task.",
      "After messaging the parent, stop and wait — their reply arrives as your next turn.",
      "Use subagents_list when you are unsure which names exist.",
    ],

    parameters: Type.Object({
      to: Type.String({
        description:
          `Display name of the recipient, or "${PARENT}" for the agent that spawned you. ` +
          "A subagent's name works whether it is still running or has already finished.",
      }),
      message: Type.String({
        description:
          "What to say: a follow-up instruction for a running subagent, the next task for a finished " +
          "one, or a question or report for the parent.",
      }),
    }),

    renderCall(args, theme) {
      const target = (args as { to?: string }).to?.trim() || "(unknown)";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const delivery = result.details as Delivery;
      return new Text(
        icon(delivery, theme) + " " + theme.fg("dim", summarize(delivery)),
        0,
        0,
      );
    },

    async execute(_toolCallId, params: { to?: string; message?: string }, _signal, _onUpdate, ctx) {
      const to = params.to?.trim() ?? "";
      const message = params.message?.trim() ?? "";

      // Validation precedes routing so a malformed call never reaches a
      // transport and never half-delivers.
      const delivery: Delivery = !message
        ? { status: "empty-message" }
        : await route(to, message, ctx as MessagingContext);

      const { text } = present(delivery);
      return { content: [{ type: "text" as const, text }], details: delivery };
    },
  });
}

export const __test__ = {
  /** Drop every contributed transport. Registration is process-global, so tests must reset it. */
  resetTransports() {
    hub().clear();
  },
};
