/** Isolated, prompt-native Pi subagent engine. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { createBtwResultData, deriveBtwTitle, type BtwResultData } from "./by-the-way.js";
import { cap, HANDOFF, PARALLEL_CHILD } from "./cap.js";
import {
  childPool,
  getFinalText,
  isLeafProcess,
  type ChildPool,
  type ChildResult,
  type ChildRun,
} from "./engine/index.js";

const MAX_PARALLEL_TASKS = 8;

const PromptItem = Type.Object({
  prompt: Type.String({ description: "Complete prompt text for the isolated child" }),
  label: Type.Optional(
    Type.String({ description: "Inert display label; it never selects instructions or defaults" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override" })),
  thinking: Type.Optional(Type.String({ description: "Reasoning level override" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit Pi tool allowlist" })),
  cwd: Type.Optional(Type.String({ description: "Child working directory override" })),
});

type PromptItemType = Static<typeof PromptItem>;

const SubagentParams = Type.Object({
  prompt: Type.Optional(Type.String({ description: "Complete prompt text for one child" })),
  label: Type.Optional(Type.String({ description: "Inert display label" })),
  tasks: Type.Optional(
    Type.Array(PromptItem, {
      description: "Independent prompt-native runs to execute in parallel",
    }),
  ),
  chain: Type.Optional(
    Type.Array(PromptItem, {
      description: "Sequential prompt-native runs; {previous} receives the capped raw prior output",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Default model for the run or child items" })),
  thinking: Type.Optional(
    Type.String({ description: "Default reasoning level for the run or child items" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Default explicit Pi tool allowlist for the run or child items",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Default child working directory" })),
});

/** One child the tool is tracking, from the moment it starts until its result arrives. */
interface ChildRecord {
  prompt: string;
  label?: string;
  step?: number;
  model?: string;
  messages: Message[];
  usage?: ChildResult["usage"];
  errorMessage?: string;
  /** Absent while the child is still running. */
  stopReason?: ChildResult["stopReason"];
}

type SubagentDetails = { mode: "single" | "parallel" | "chain"; results: ChildRecord[] };
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function startedRecord(run: ChildRun, step?: number, messages: Message[] = []): ChildRecord {
  return { prompt: run.prompt, label: run.label, step, model: run.model, messages };
}

function settledRecord(run: ChildRun, step: number | undefined, result: ChildResult): ChildRecord {
  return {
    ...startedRecord(run, step, result.messages),
    model: result.model ?? run.model,
    usage: result.usage,
    errorMessage: result.errorMessage,
    stopReason: result.stopReason,
  };
}

/** Pi expects an aborted tool call to reject, so the engine's queue abort is rethrown. */
function abortError(message = "Subagent execution was aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function finalOutput(messages: Message[]): string {
  return getFinalText({ messages }, "");
}

function formatUsage(usage: ChildRecord["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage?.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage?.input) parts.push(`↑${usage.input}`);
  if (usage?.output) parts.push(`↓${usage.output}`);
  if (usage?.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function validPrompt(prompt: string | undefined): prompt is string {
  return typeof prompt === "string" && prompt.trim().length > 0;
}

function mergeRun(item: ChildRun, defaults: ChildRun): ChildRun {
  return {
    prompt: item.prompt,
    label: item.label,
    cwd: item.cwd ?? defaults.cwd,
    model: item.model ?? defaults.model,
    thinking: item.thinking ?? defaults.thinking,
    tools: item.tools ?? defaults.tools,
  };
}

function displayLabel(result: ChildRecord, fallback: string): string {
  return result.label || fallback;
}

export interface SubagentExtensionDependencies {
  /** The one injectable dependency. Substitute a real pool; permits are never fakeable. */
  pool?: ChildPool;
}

/** How a run is named in the working message: its label, and its model when set. */
function describeRun(run: ChildRun): string {
  return `${run.label ?? "subagent"}${run.model ? ` · ${run.model}` : ""}`;
}

/** What a mode executor needs from the tool call it runs inside. */
interface ModeContext {
  runOne: (
    run: ChildRun,
    step: number | undefined,
    update?: OnUpdateCallback,
  ) => Promise<ChildRecord>;
  details: (mode: SubagentDetails["mode"], results?: ChildRecord[]) => SubagentDetails;
  defaults: ChildRun;
  onUpdate?: OnUpdateCallback;
  setWorking: (message?: string) => void;
}

type ModeOutcome = Promise<AgentToolResult<SubagentDetails>>;

/** One child, its output returned verbatim. */
async function runSingleMode(
  prompt: string,
  label: string | undefined,
  modeCtx: ModeContext,
): ModeOutcome {
  const run = mergeRun({ prompt: prompt, label: label }, modeCtx.defaults);
  modeCtx.setWorking(`Running ${describeRun(run)}`);
  try {
    const result = await modeCtx.runOne(run, undefined, modeCtx.onUpdate);
    const error = result.errorMessage;
    return {
      content: [
        {
          type: "text",
          text: cap(error ? `Subagent failed: ${error}` : finalOutput(result.messages)),
        },
      ],
      details: modeCtx.details("single", [result]),
    };
  } finally {
    modeCtx.setWorking();
  }
}

/** Ordered children, each seeing the previous child's capped final text. */
async function runChainMode(items: PromptItemType[], modeCtx: ModeContext): ModeOutcome {
  const results: ChildRecord[] = [];
  let previous = "";
  try {
    for (const [index, item] of items.entries()) {
      const run = mergeRun(
        { ...item, prompt: item.prompt.replace(/\{previous\}/g, previous) },
        modeCtx.defaults,
      );
      modeCtx.setWorking(`Chain ${index + 1}/${items.length}: ${describeRun(run)}`);
      const result = await modeCtx.runOne(
        run,
        index + 1,
        modeCtx.onUpdate
          ? (partial) =>
              modeCtx.onUpdate?.({
                content: partial.content,
                details: modeCtx.details("chain", [...results, ...partial.details!.results]),
              })
          : undefined,
      );
      results.push(result);
      const error = result.errorMessage;
      if (error)
        return {
          content: [
            {
              type: "text",
              text: cap(
                `Chain stopped at step ${index + 1} (${displayLabel(result, "subagent")}): ${error}`,
              ),
            },
          ],
          details: modeCtx.details("chain", results),
        };
      previous = cap(finalOutput(result.messages), HANDOFF);
    }
    return {
      content: [{ type: "text", text: cap(finalOutput(results.at(-1)!.messages)) }],
      details: modeCtx.details("chain", results),
    };
  } finally {
    modeCtx.setWorking();
  }
}

/** Independent children, summarised per child. */
async function runParallelMode(items: PromptItemType[], modeCtx: ModeContext): ModeOutcome {
  if (items.length > MAX_PARALLEL_TASKS)
    throw new Error(`Too many parallel tasks (${items.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  const running: ChildRecord[] = items.map((item) =>
    startedRecord(mergeRun(item, modeCtx.defaults)),
  );
  const emitProgress = () =>
    modeCtx.onUpdate?.({
      content: [
        {
          type: "text",
          text: `Parallel: ${running.filter((result) => result.stopReason).length}/${running.length} done...`,
        },
      ],
      details: modeCtx.details("parallel", [...running]),
    });
  modeCtx.setWorking(`Running ${items.length} prompts in parallel`);
  try {
    // No local limiter: every item asks the engine for a permit and queues
    // there, which is the single authority on the child bound.
    const results = await Promise.all(
      items.map(async (item, index) => {
        const result = await modeCtx.runOne(
          mergeRun(item, modeCtx.defaults),
          undefined,
          (partial) => {
            running[index] = partial.details!.results[0]!;
            emitProgress();
          },
        );
        running[index] = result;
        emitProgress();
        return result;
      }),
    );
    const successCount = results.filter((result) => !result.errorMessage).length;
    const summary = results
      .map(
        (result, index) =>
          `[${displayLabel(result, `prompt-${index + 1}`)}] ${result.errorMessage ? "failed" : "completed"}: ${cap(result.errorMessage ?? finalOutput(result.messages), PARALLEL_CHILD)}`,
      )
      .join("\n\n");
    return {
      content: [
        {
          type: "text",
          text: cap(`Parallel: ${successCount}/${results.length} succeeded\n\n${summary}`),
        },
      ],
      details: modeCtx.details("parallel", results),
    };
  } finally {
    modeCtx.setWorking();
  }
}

export function registerSubagentExtension(
  pi: ExtensionAPI,
  { pool = childPool }: SubagentExtensionDependencies = {},
): void {
  if (isLeafProcess()) return;

  let closed = false;
  let nextBtwId = 1;
  const activeBtwRuns = new Map<string, AbortController>();

  const settleBtw = (id: string, ctx: ExtensionCommandContext, data: BtwResultData) => {
    if (!activeBtwRuns.delete(id) || closed) return;
    pi.appendEntry("btw-result", data);
    ctx.ui.notify(
      data.status === "completed"
        ? `By the way complete: ${data.title}`
        : `By the way failed: ${data.title}`,
      data.status === "completed" ? "info" : "error",
    );
  };

  pi.registerEntryRenderer<BtwResultData>("btw-result", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return new Text(theme.fg("error", "Invalid by-the-way result"), 0, 0);
    const output = data.error ?? data.answer;
    const container = new Container();
    container.addChild(
      new Text(
        `${data.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold(`btw: ${data.title}`))}`,
        0,
        0,
      ),
    );
    if (expanded) {
      container.addChild(new Text(theme.fg("muted", "Question"), 0, 0));
      container.addChild(new Text(theme.fg("dim", data.prompt), 0, 0));
      container.addChild(new Text(theme.fg("muted", data.error ? "Error" : "Answer"), 0, 0));
      container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
    } else {
      container.addChild(
        new Text(
          theme.fg(data.error ? "error" : "toolOutput", output.split("\n").slice(0, 3).join("\n")),
          0,
          0,
        ),
      );
    }
    return container;
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off side question without adding its result to the model context",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/btw is available only in the TUI.", "warning");
        return;
      }
      const question =
        args.trim() || (await ctx.ui.input("by the way", "Ask a one-off question…"))?.trim();
      if (!question || closed) return;

      const id = `btw-${nextBtwId++}`;
      const title = deriveBtwTitle(question);
      const controller = new AbortController();
      activeBtwRuns.set(id, controller);
      const run: ChildRun = {
        prompt: question,
        label: title,
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: pi.getThinkingLevel(),
      };
      // A side question asks for a permit without waiting: a busy pool answers now.
      void pool
        .run(run, undefined, { signal: controller.signal, policy: "reject" })
        .then((result) => {
          if (result.stopReason === "pool-full") {
            activeBtwRuns.delete(id);
            if (!closed)
              ctx.ui.notify(
                "All subagent execution slots are busy. Try /btw again shortly.",
                "warning",
              );
            return;
          }
          settleBtw(id, ctx, createBtwResultData(id, title, question, result));
        });
    },
  });

  pi.on("session_shutdown", () => {
    closed = true;
    pool.cancelQueued();
    for (const controller of activeBtwRuns.values()) controller.abort();
    activeBtwRuns.clear();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run complete caller-provided prompts in isolated Pi subprocesses. Use exactly one mode: prompt, tasks, or chain.",
    promptGuidelines: [
      "Supply the complete child prompt. This tool does not discover named agents or add instructions.",
      "Use parallel mode only for independent work; use chain for ordered prompt handoffs.",
      "Review edits and important claims in the parent context.",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const defaults: ChildRun = {
        prompt: "",
        model: params.model,
        thinking: params.thinking,
        tools: params.tools,
        cwd: params.cwd,
      };
      const hasSingle = params.prompt !== undefined;
      const hasTasks = params.tasks !== undefined;
      const hasChain = params.chain !== undefined;
      const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
      const details = (
        mode: SubagentDetails["mode"],
        results: ChildRecord[] = [],
      ): SubagentDetails => ({ mode, results });
      if (modeCount !== 1)
        throw new Error("Invalid parameters. Provide exactly one of prompt, tasks, or chain.");
      const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const prompts = hasSingle
        ? [params.prompt]
        : (params.tasks ?? params.chain ?? []).map((item) => item.prompt);
      if (prompts.length === 0 || prompts.some((prompt) => !validPrompt(prompt)))
        throw new Error("Every selected mode must contain a non-empty prompt.");

      const runOne = async (
        run: ChildRun,
        step: number | undefined,
        update?: OnUpdateCallback,
      ): Promise<ChildRecord> => {
        const streamed: Message[] = [];
        const result = await pool.run(
          run,
          update &&
            ((event) => {
              streamed.push(event.message);
              update({
                content: [
                  {
                    type: "text",
                    text: cap(finalOutput(streamed) || "(running...)"),
                  },
                ],
                details: details(mode, [startedRecord(run, step, [...streamed])]),
              });
            }),
          { cwd: ctx.cwd, signal },
        );
        if (result.stopReason === "queue-aborted") throw abortError(result.errorMessage);
        return settledRecord(run, step, result);
      };
      const modeCtx: ModeContext = {
        runOne,
        details,
        defaults,
        onUpdate,
        setWorking: (message?: string) => {
          if (ctx.hasUI) ctx.ui.setWorkingMessage(message);
        },
      };
      if (hasSingle) return runSingleMode(params.prompt!, params.label, modeCtx);
      if (hasChain) return runChainMode(params.chain!, modeCtx);
      return runParallelMode(params.tasks!, modeCtx);
    },
    renderCall(args, theme) {
      const items = args.chain ?? args.tasks;
      if (items?.length)
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `${args.chain ? "chain" : "parallel"} (${items.length})`)}`,
          0,
          0,
        );
      const preview = args.prompt ? args.prompt.slice(0, 80) : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.label ?? "prompt")}\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length)
        return new Text(
          result.content[0]?.type === "text" ? result.content[0].text : "(no output)",
          0,
          0,
        );
      const container = new Container();
      for (const [index, run] of details.results.entries()) {
        const error = run.errorMessage;
        const label = displayLabel(run, `prompt-${index + 1}`);
        container.addChild(
          new Text(
            `${error ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(label))}${run.model ? theme.fg("dim", ` · ${run.model}`) : ""}`,
            0,
            0,
          ),
        );
        if (expanded) {
          container.addChild(new Text(theme.fg("muted", "Prompt"), 0, 0));
          container.addChild(new Text(theme.fg("dim", run.prompt), 0, 0));
          container.addChild(
            new Text(theme.fg("muted", error ? `Error: ${error}` : "Output"), 0, 0),
          );
          container.addChild(
            new Markdown(
              (error ? error : finalOutput(run.messages)).trim(),
              0,
              0,
              getMarkdownTheme(),
            ),
          );
        } else
          container.addChild(
            new Text(
              theme.fg(
                error ? "error" : "toolOutput",
                (error ? error : finalOutput(run.messages)).split("\n").slice(0, 3).join("\n"),
              ),
              0,
              0,
            ),
          );
        const usage = formatUsage(run.usage, run.model);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
        if (index < details.results.length - 1) container.addChild(new Spacer(1));
      }
      return container;
    },
  });
}

export default function subagentExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
