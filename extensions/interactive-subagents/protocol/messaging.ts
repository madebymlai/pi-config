/**
 * send_message — one tool for talking to any agent in this lineage.
 *
 * Replaces a since-removed pair of tools that split the job by direction of
 * travel: one addressed a subagent by name going down, the other addressed the
 * orchestrator implicitly going up. Neither could be documented without the
 * other, and a spawning worker held both at once, choosing between them purely
 * on which way the message was headed.
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
 *      which loads index.ts and child/index.ts in one process, has two
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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
  | { status: "sent-to-parent" }
  | { status: "no-parent" }
  | { status: "no-default-recipient"; known: string[] }
  | { status: "unknown-target"; known: string[] }
  | { status: "empty-message" }
  | { status: "unresumable"; reason: string }
  | { status: "transport-failed"; reason: string };

export interface Transport {
  /** Recipients this transport can reach right now. Used only to explain an unknown name. */
  known(ctx: MessagingContext): string[];
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

function hub() {
  const globals = globalThis as Record<symbol, unknown>;
  let existing = globals[HUB_KEY] as Map<Contributor, Transport[]> | undefined;
  if (!existing) {
    existing = new Map();
    globals[HUB_KEY] = existing;
  }
  return existing;
}

/**
 * The transports eligible to serve `to`.
 *
 * `parent` is reserved, so it is offered ONLY to the transport contributed for
 * it. Without this a stale registry entry named "parent" — one written before
 * the name was reserved — would be resumed as a subagent by the child
 * transports, which run first, and the real parent would be unreachable.
 * Refusing the name at spawn time cannot fix a registry that already has it.
 */
function eligibleTransports(to: string) {
  if (to === PARENT) return hub().get("parent") ?? [];
  return CONTRIBUTORS.flatMap((contributor) => hub().get(contributor) ?? []);
}

function allTransports() {
  return CONTRIBUTORS.flatMap((contributor) => hub().get(contributor) ?? []);
}

function reasonOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message || "(no detail)";
}

/**
 * Ask each transport in turn; the first to claim the recipient decides the
 * outcome. `defaulted` says the caller left `to` unset and it was resolved to
 * the parent, which only changes how an unreachable parent is explained.
 */
async function route(
  to: string,
  message: string,
  ctx: MessagingContext,
  defaulted = false,
): Promise<Delivery> {
  const transports = eligibleTransports(to);
  let failure: Delivery | null = null;

  for (const transport of transports) {
    try {
      const delivery = await transport.deliver(to, message, ctx);
      if (delivery) return delivery;
    } catch (error) {
      // A transport that throws is buggy, not authoritative: it never said the
      // recipient was its own. Keep asking the rest so one broken transport
      // cannot make every other recipient unreachable, and report its failure
      // only if nothing else claims `to`.
      failure ??= { status: "transport-failed", reason: reasonOf(error) };
    }
  }

  if (failure) return failure;

  // Nothing claimed it. Three different mistakes, so three different messages:
  // relying on a default with nothing above you, naming a parent you do not
  // have, and naming a subagent that does not exist.
  if (to === PARENT && !defaulted) return { status: "no-parent" };

  // Listing recipients is a different question from delivering to one: a
  // defaulted `to` narrowed the search to the parent slot, but the names worth
  // suggesting are every name anything can reach.
  const known: string[] = [];
  for (const transport of defaulted ? allTransports() : transports) {
    try {
      for (const name of transport.known(ctx)) if (!known.includes(name)) known.push(name);
    } catch {
      // A transport that cannot list its recipients still must not stop the
      // others from explaining themselves.
    }
  }

  if (defaulted) return { status: "no-default-recipient", known };
  return { status: "unknown-target", known };
}

/**
 * How one outcome reads. Annotated because the literal tones must stay literal:
 * they index the theme's colours, and inference would widen them to string.
 *
 * One switch rather than three parallel ones, so a new Delivery variant is a
 * single type error here instead of silently rendering as a generic failure.
 */
interface Presentation {
  tone: "success" | "accent" | "error";
  glyph: string;
  /** The collapsed one-liner in the transcript. */
  summary: string;
  /** What the calling agent reads as the tool result. */
  text: string;
}

function describe(delivery: Delivery): Presentation {
  switch (delivery.status) {
    case "steered":
      return {
        tone: "success",
        glyph: "✓",
        summary: `${delivery.name} — message delivered`,
        text:
          `Message delivered to running subagent "${delivery.name}". It picks this up at its next ` +
          `turn boundary. If it exits, its result still arrives as a steer message.`,
      };
    case "resumed":
      return {
        tone: "accent",
        glyph: "⟳",
        summary: `${delivery.name} — resumed`,
        text:
          `Session "${delivery.name}" resumed. This is fire-and-forget: when it finishes, its ` +
          `result is delivered to you automatically. Do not poll, sleep, or read session files.`,
      };
    case "sent-to-parent":
      return {
        tone: "accent",
        glyph: "↑",
        summary: "orchestrator — message sent",
        text:
          "Message sent to the orchestrator. Stop here and wait. Do not continue working or " +
          "assume an answer. Their reply will arrive as your next message.",
      };
    case "no-parent":
      return {
        tone: "error",
        glyph: "✗",
        summary: "no parent to message",
        text:
          `You are the top-level session, so there is no "${PARENT}" to message. ` +
          `Address a subagent by name instead.`,
      };
    case "no-default-recipient":
      return {
        tone: "error",
        glyph: "✗",
        summary: "no recipient named",
        text:
          `You left \`to\` unset, which means "the agent that spawned me", but you are the ` +
          `top-level session and nothing spawned you. Name the recipient explicitly. ` +
          (delivery.known.length > 0
            ? `Known recipients: ${delivery.known.join(", ")}.`
            : `No subagents are addressable yet.`),
      };
    case "unknown-target":
      return {
        tone: "error",
        glyph: "✗",
        summary: "unknown recipient",
        text:
          delivery.known.length > 0
            ? `No recipient named that in this session. Known recipients: ${delivery.known.join(", ")}.`
            : "No recipient named that in this session, and nothing is addressable yet.",
      };
    case "empty-message":
      return {
        tone: "error",
        glyph: "✗",
        summary: "empty message",
        text: "`message` is required. There is nothing to deliver.",
      };
    case "unresumable":
      return {
        tone: "error",
        glyph: "✗",
        summary: `cannot resume — ${delivery.reason}`,
        text: delivery.reason,
      };
    case "transport-failed":
      return {
        tone: "error",
        glyph: "✗",
        summary: `delivery failed — ${delivery.reason}`,
        text: `Delivery failed: ${delivery.reason}`,
      };
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
) {
  hub().set(contributor, transports);

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to another agent in this session. Omit `to` to reach the agent that " +
      "spawned you, which is the usual case. Name a sub-agent in `to` to reach it instead. " +
      "One name reaches a sub-agent whether it is still running or already finished: a running " +
      "one is steered mid-task, a finished one is resumed and continues. " +
      "Every form returns immediately. Steering only acknowledges and produces no new result by " +
      "itself. Resuming is fire and forget: the resumed session's result arrives later as a " +
      "steer message. Messaging the agent that spawned you holds your session open, and their " +
      "reply arrives as your next message. " +
      "Never poll, sleep, tail logs, or read session files to detect a reply, and never state a " +
      "reply you have not received.",
    promptSnippet:
      "Message another agent. Omit `to` to reach the one that spawned you, or name a sub-agent " +
      "in `to` to reach it instead. Never poll for a reply and never invent one.",
    promptGuidelines: [
      "Leave `to` unset to reach the agent that spawned you. Any other recipient is a sub-agent's display name.",
      "Display names come from the spawn acknowledgement, the widget, and the follow-up line on a result. Name one wrong and the error lists the names that exist.",
      "Ask one thing per message. Make separate calls for unrelated questions.",
      "Give enough context that the recipient can act without re-reading your whole task.",
      "After messaging the agent that spawned you, stop and wait. Their reply arrives as your next turn.",
    ],

    parameters: Type.Object({
      to: Type.Optional(
        Type.String({
          description:
            "Display name of the recipient, which reaches that sub-agent whether it is still " +
            `running or already finished. Omit it to reach the agent that spawned you, or say ` +
            `"${PARENT}" to say so explicitly. A top-level session has nothing above it and must ` +
            "name a recipient.",
        }),
      ),
      message: Type.String({
        description:
          "What to say: a follow-up instruction for a running sub-agent, the next task for a " +
          "finished one, or a question or report for the agent that spawned you.",
      }),
    }),

    renderCall(args, theme) {
      const target = (args as { to?: string }).to?.trim() || PARENT;
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
        0,
        0,
      );
    },

    renderResult(result, _options, theme: Theme) {
      const { tone, glyph, summary } = describe(result.details as Delivery);
      return new Text(theme.fg(tone, glyph) + " " + theme.fg("dim", summary), 0, 0);
    },

    async execute(_toolCallId, params: { to?: string; message?: string }, _signal, _onUpdate, ctx) {
      const named = params.to?.trim() ?? "";
      // No recipient means the agent that spawned you — the only direction a
      // subagent can mean without saying so. A top-level session has nothing
      // above it and is told to name someone.
      const to = named || PARENT;
      const message = params.message?.trim() ?? "";

      // Validation precedes routing so a malformed call never reaches a
      // transport and never half-delivers.
      const delivery: Delivery = !message
        ? { status: "empty-message" }
        : await route(to, message, ctx as MessagingContext, !named);

      return {
        content: [{ type: "text" as const, text: describe(delivery).text }],
        details: delivery,
      };
    },
  });
}

export const __test__ = {
  /** Drop every contributed transport. Registration is process-global, so tests must reset it. */
  resetTransports() {
    hub().clear();
  },
};
