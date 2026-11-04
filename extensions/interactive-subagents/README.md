# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. With one agent, the window shows Main on the left and that agent directly on the right. When a second agent starts, the right half becomes a flat agent list. If you explicitly open an agent, further arrivals and departures preserve that view while the selected agent is still running. Additional agents never shrink the main pane. Each agent keeps its own pane and process; hidden panes are parked in a detached tmux session.

```text
─ Main ─────────────────────────┬─ Agents list ──────────────────────────────
                                │                                    2 running
                                │
                                │   AGENT                 ACTIVITY     ELAPSED
                                │ → scout (scout)         reading          23s
                                │   fix-login (worker)    waiting          45s
                                │
                                │ ────────────────────────────────────────────
2 subagents                     │ Enter Open   Esc Main
>                               │
```

- **Click a row or press Enter** to replace the list with that agent's live terminal in the right half. Use **↑/↓**, **Home/End**, or **PgUp/PgDn** to navigate the list.
- **← on an empty prompt**, in either the main session or an agent, opens and focuses the list (or the sole agent when there is only one). With a draft, ← retains its normal cursor movement; dialog arrows are untouched.
- **Ctrl+Alt+A from either pane** does the same even with a draft or a focused dialog. The shortcut is listed in Pi's `/hotkeys`; switching views preserves the draft and leaves agents running.
- **Esc in the list** focuses the main session without changing the right pane. ← does nothing in the list, so holding it cannot bounce focus back and forth.
- **Ctrl+Z retains Pi's normal suspend behavior** in main and agent sessions. There is no browse command to run: the layout follows the number of agents automatically.

The top pane borders label **Main**, **Agents list**, or the selected agent's name and role (for example, **Alpha (worker)**). The focused label is highlighted blue; inactive labels are dim and all border lines stay grey. These window-local settings are restored when the deck closes.

The list keeps its running count without repeating the pane title. It uses aligned agent, activity, and elapsed-time columns, with the selected row highlighted and shortcuts in a separate footer. Narrow panes drop activity first, then elapsed time, to preserve agent names. The main session shows only the running count; its navigation keys still work but have no redundant hint. Child tool widgets put shortcuts on their own line, labelled **Agents list**. The list footer shows only its own controls rather than repeating the session shortcuts. Both Pi panes reserve a status row, blank when unused, so a warning such as **BG OFF** in the main session does not shift its editor relative to a child.

The list uses its own fullscreen TUI, so clicks do not depend on the main Pi session's display mode. If tmux intercepts clicks rather than forwarding them, enable mouse support with `tmux set -g mouse on`.

Hidden agents keep running concurrently, and results are steered back independently as each finishes. When only one agent remains, it is shown directly. At zero agents, the empty list holds the right-hand slot for **30 seconds**, then Main expands to full width. An agent starting during that grace period cancels the collapse. With multiple agents remaining, closing the visible agent returns to the list; closing a hidden agent preserves the selected view. Session shutdown or reload cancels any pending collapse and cleans up the list and all owned panes. The main widget is a one-line count rather than a second copy of the list.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `send_message` | Message any agent in this lineage — omit `to` for the one that spawned you, or name a sub-agent to steer it if running or resume it if finished |
| `subagents_list` | List available agent definitions |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`send_message` is addressed **by name**, one namespace covering both directions. Names are unique per session and persist after a sub-agent finishes, so the same name works whether it is running or done:

```typescript
send_message({ to: "scout", message: "Also check the auth middleware" });
send_message({ message: "Should I use the v1 or v2 endpoint?" }); // → the agent that spawned you
```

Leaving `to` unset means the agent that spawned you — the only direction a sub-agent can mean, since sub-agents have no children of their own. `"parent"` still works if you prefer to say it. A top-level session has no parent, so omitting `to` there is an error that lists the names it could have used instead.

- **Running sub-agent** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished sub-agent** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.
- **`"parent"`** — see [Messaging the orchestrator](#messaging-the-orchestrator) below. Available only inside a sub-agent session; a top-level session is told it has no parent.

Because `"parent"` is reserved, no sub-agent can be spawned under a name that would shadow it.

Which recipients a session can reach follows from which extensions it loads, not from a runtime check: the top-level session reaches its children, and a sub-agent reaches its parent.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### Messaging the orchestrator

A sub-agent uses `send_message({ message: … })` when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies with `send_message({ to: <that name>, … })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `deepseek/deepseek-flash` | `read`, `grep`, `find`, `ls`, `safe_bash`, graph tools | Fast read-only codebase recon |
| **researcher** | `deepseek/deepseek-flash` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openai-codex/gpt-6-astra` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch`, graph tools | General implementer |
| **reviewer** | `openai-codex/gpt-6-astra` | `read`, `grep`, `find`, `ls`, `safe_bash`, graph tools | Reviews a diff it did not write |
| **designer** | `openai-codex/gpt-6-astra` | `read`, `grep`, `find`, `ls`, graph tools | Proposes an interface, builds nothing |

All five are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`, except researcher which uses `replace`). The reviewer uses a fresh context and its own prompt. The designer is read-only by design rather than by accident: without a write tool it cannot slide from proposing into building, and several can be dispatched in parallel under different constraints to produce alternatives worth comparing. Each is also told, in that prompt, to `send_message` the orchestrator rather than guess when the task is ambiguous — `send_message` is granted to every sub-agent regardless of its `tools:` line.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down once the agent's run settles — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **A turn ending is not the run ending.** pi weighs an auto-retry after the turn ends, and a transient provider error — a websocket dropped mid-stream, an overload — is retryable by default. Exit is decided at `agent_settled`, once no retry, compaction or queued continuation is coming, so a blip pi recovers from on the next attempt no longer ends the sub-agent and reports the run as failed.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when a message to the parent is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Only the top-level session spawns. Sub-agents are leaves: they are never granted `subagent` or `subagents_list`, so the hierarchy is exactly one level deep and there is no allowlist to propagate. Every spawn must name a known agent — there is no agentless route, so a child can never escalate to a full-toolset profile by omitting its agent.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The right-hand list tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`. Disabling status display hides activity labels in the list but keeps names and elapsed times.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/earendil-works/pi) 1.4.0 or later (this repo uses 1.5.0)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
