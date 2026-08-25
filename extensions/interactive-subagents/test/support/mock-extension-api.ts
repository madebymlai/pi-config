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

export function createMockExtensionApi() {
  const registeredTools: RecordedTool[] = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
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
