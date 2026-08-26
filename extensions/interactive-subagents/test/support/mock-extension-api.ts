/**
 * A recording stand-in for pi's ExtensionAPI.
 *
 * Registering an extension against it and then driving a tool's `execute` is
 * the seam these suites test through, so this lives in one place rather than
 * being re-declared per file.
 */
/** What every tool's execute resolves to, so tests can read it without casting. */
export interface RecordedToolResult {
  content: Array<{ type: string; text: string }>;
  details?: any;
}

/**
 * A tool as the mock recorded it. Loose everywhere except `execute`, whose
 * return type is what tests actually assert on: left as `any` it infers back to
 * `unknown` through an awaited generic and every assertion needs a cast.
 */
export interface RecordedTool {
  name: string;
  execute(...args: any[]): Promise<RecordedToolResult>;
  [key: string]: any;
}

/**
 * A recording stand-in for pi's ExtensionContext.
 *
 * `hasUI` defaults to true because the paint paths all early-return without it:
 * a context that reports no UI makes every widget assertion vacuously pass,
 * which is precisely how an unwired observer once survived a green suite.
 */
export function createMockContext(opts: { hasUI?: boolean; sessionDir?: string; sessionId?: string } = {}) {
  const widgets: Array<{ key: string; value: unknown }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    widgets,
    statuses,
    notifications,
    /** The widget currently installed under `key`, or undefined if it was cleared. */
    currentWidget(key = "subagent-status") {
      const seen = widgets.filter((w) => w.key === key);
      return seen.length ? seen[seen.length - 1].value : undefined;
    },
    ctx: {
      hasUI: opts.hasUI ?? true,
      ui: {
        setWidget(key: string, value: unknown) {
          widgets.push({ key, value });
        },
        setStatus(key: string, value: unknown) {
          statuses.push({ key, value });
        },
        notify(text: string, level: string) {
          notifications.push({ text, level });
        },
        theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
      sessionManager: {
        getSessionDir: () => opts.sessionDir ?? "/nonexistent",
        getSessionId: () => opts.sessionId ?? "none",
        getSessionFile: () => null,
      },
    } as any,
  };
}

export function createMockExtensionApi() {
  const registeredTools: RecordedTool[] = [];
  /** Event handlers, so a test can drive a real session lifecycle. */
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    /**
     * Fire a pi lifecycle event at every handler the extension registered.
     * `on()` used to be a no-op here, which meant no suite could reach anything
     * a session_start or session_shutdown set up.
     */
    async emit(event: string, payload: any, ctx: any) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    handlerCount(event: string) {
      return (handlers.get(event) ?? []).length;
    },
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
      },
      registerTool(tool: RecordedTool) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}
