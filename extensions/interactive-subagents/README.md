# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `spawn/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

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
| **scout** | `deepseek/deepseek-v4-flash` | `read`, `grep`, `find`, `ls`, graph tools | Fast read-only codebase recon |
| **researcher** | `deepseek/deepseek-v4-flash` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `deepseek/deepseek-v4-pro` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch`, graph tools | General implementer |
| **reviewer** | `openai-codex/gpt-5.5` | `read`, `grep`, `find`, `ls`, `safe_bash`, graph tools | Reviews a diff it did not write |

All four are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`, except researcher which uses `replace`). The reviewer runs on a different provider from the worker on purpose: a verifier sharing the author's model family tends to confirm its own errors. Each is also told, in that prompt, to `send_message` the orchestrator rather than guess when the task is ambiguous — `send_message` is granted to every sub-agent regardless of its `tools:` line.

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

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
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

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
