/**
 * Registers the extension over a caller-supplied pool and hands back every surface it
 * registered. Extension contexts stay with the tests, because each one needs a different
 * UI; only the registration side is shared.
 */

import type { ChildPool } from "../../engine/index.js";
import { registerSubagentExtension } from "../../index.js";

type Handler = (...args: any[]) => void;
type Listener = (payload: unknown) => void;
type Command = { handler(args: string, ctx: any): Promise<void>; description?: string };
type Tool = { execute: (...args: any[]) => Promise<any> };

class FakeBus {
  private readonly listeners = new Map<string, Listener[]>();

  on(topic: string, listener: Listener): () => void {
    const listeners = this.listeners.get(topic) ?? [];
    listeners.push(listener);
    this.listeners.set(topic, listeners);
    return () => {};
  }

  emit(topic: string, payload: unknown): void {
    for (const listener of this.listeners.get(topic) ?? []) listener(payload);
  }
}

export function registerExtension(pool: ChildPool) {
  const bus = new FakeBus();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  let tool: Tool | undefined;

  registerSubagentExtension(
    {
      events: bus,
      registerTool(value: Tool) {
        tool = value;
      },
      registerCommand(name: string, command: Command) {
        commands.set(name, command);
      },
      registerEntryRenderer() {},
      appendEntry(type: string, data: Record<string, unknown>) {
        entries.push({ type, data });
      },
      getThinkingLevel() {
        return "high";
      },
      on(event: string, handler: Handler) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
      sendMessage() {
        throw new Error("the extension must not send a parent-model message");
      },
    } as never,
    { pool },
  );

  const btw = commands.get("btw");
  if (!tool || !btw) throw new Error("the extension did not register its tool and /btw command");

  return {
    tool,
    btw,
    entries,
    /** Invoke every listener the extension registered for one Pi lifecycle event. */
    fire(event: string, ...args: unknown[]): void {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}
