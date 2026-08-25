# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls in the main session and prompts before running
anything destructive or questionable.

## Modes

### Enabled (default) — interactive prompt

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Prompts for **any** `git ...` command (escalates severity for especially risky ones: `git rm`,
  `git reset --hard`, `git clean -fdx`, `git push --force`, `git reflog expire`, `git gc --prune`)
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `curl|sh`/`wget|sh`, `kubectl delete`, `terraform destroy`,
  `aws s3 rm --recursive`, `gcloud delete`, shell redirections (`>`, `>>`, `2>`), pipes
- Shows a 2-option dialog: **Run** / **Abort**
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

### Disabled (autonomous) — hard-block floor only

Turn the prompt off with `/bash-guard` (session-local toggle) or start the session with
`--bash-guard-disabled`. A red `⚠ BG OFF` badge stays in the status line while disabled.

Prompting is skipped entirely, but a floor of catastrophic/unrecoverable operations stays
hard-blocked with no user interaction:

| Pattern | Reason |
|---|---|
| `rm -r` / `-rf` / `-Rf` | Recursive deletion |
| `sudo` | Elevated privileges |
| `curl\|sh`, `wget\|sh` | Pipe to shell (remote code execution) |
| `mkfs*`, `newfs_*` | Filesystem formatting |
| `wipefs` | Disk signature wipe |
| `diskutil erase/zeroDisk/secureErase/reformat` | Destructive disk operation |
| `dd of=/dev/…` | Raw disk write |
| `parted`, `fdisk`, `gdisk`, `sgdisk` | Partition table management |
| `cryptsetup` | Disk encryption management |
| `zpool` | ZFS pool management |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power operation |
| `terraform destroy` | Infrastructure teardown |
| `kubectl delete` | Kubernetes resource deletion |
| `aws s3 rm --recursive` | Bulk S3 deletion |
| `git reset --hard` | Discard all uncommitted changes |
| `git clean -f` | Delete untracked files |
| `git reflog expire` | Remove recovery history |
| `git gc --prune` | Prune unreachable objects |

Routine git operations (`commit`, `pull`, `push`) pass through: disabling bash-guard is an
explicit opt-in to autonomy, and those are recoverable.

The toggle is session-local and deliberately not persisted — `/reload` or a restart puts the
prompt back on.

## Subagents

Subagents never load this extension: children run with `--no-extensions` and an explicit
`-e` whitelist that does not include bash-guard. A subagent's bash protection comes from
`interactive-subagents/child/tools/safe-bash.ts`, granted when a role's `tools:` frontmatter
lists `safe_bash`.

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- `/bash-guard`: toggle the prompt off/on for this session.
- `--bash-guard-disabled`: start the session with the prompt already off.
- `--bash-guard-auto-allow`: allow flagged commands when there is no UI (e.g. running pi
  non-interactively). Not a disable switch — it only applies when prompting is impossible.
