import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Footer } from "./footer.ts";

export default function (pi: ExtensionAPI): void {
  let dispose = () => {};
  let requestRender = () => {};
  pi.on("model_select", () => requestRender());
  pi.on("thinking_level_select", () => requestRender());
  pi.on("session_shutdown", () => {
    dispose();
    requestRender = () => {};
  });
  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      dispose();
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      let active = true;
      const cleanup = () => {
        if (!active) return;
        active = false;
        requestRender = () => {};
        unsubscribe();
      };
      dispose = cleanup;
      let cached:
        | {
            session: string;
            leaf: string | null;
            input: number;
            output: number;
          }
        | undefined;
      const footer = new Footer(() => {
        const manager = ctx.sessionManager;
        const session = manager.getSessionId();
        const leaf = manager.getLeafId();
        // Session entries are append-only and every append moves the leaf. The public
        // read-only manager has no getEntryCount(); avoid copying entries every frame.
        if (!cached || cached.session !== session || cached.leaf !== leaf) {
          let input = 0,
            output = 0;
          for (const entry of manager.getEntries()) {
            const usage =
              entry.type === "usage" ||
              entry.type === "compaction" ||
              entry.type === "branch_summary"
                ? entry.usage
                : entry.type === "message" &&
                    (entry.message.role === "assistant" ||
                      entry.message.role === "toolResult")
                  ? entry.message.usage
                  : undefined;
            if (usage) {
              input += usage.input;
              output += usage.output;
            }
          }
          cached = { session, leaf, input, output };
        }
        const context = ctx.getContextUsage();
        return {
          model: ctx.model?.id ?? "no-model",
          thinking: pi.getThinkingLevel(),
          input: cached.input,
          output: cached.output,
          used: context?.tokens ?? null,
          contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
          project: basename(ctx.cwd),
          branch: footerData.getGitBranch() ?? undefined,
          statuses: footerData.getExtensionStatuses(),
        };
      }, theme);
      return {
        render: (width) => footer.render(width),
        invalidate: () => footer.invalidate(),
        dispose: cleanup,
      };
    });
  });
}
