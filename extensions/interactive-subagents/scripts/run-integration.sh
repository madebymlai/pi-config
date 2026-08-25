#!/usr/bin/env bash
# Run the tmux integration tests in a tmux session of their own.
#
# These tests create panes with `tmux split-window`, which splits the CURRENT
# window. Run from inside your own tmux session they therefore split the
# terminal you are working in: panes appear beside your editor or shell, every
# split halves the width, and whatever is running there reflows around them.
# Being inside tmux is what makes running them directly destructive, not what
# makes it safe.
#
# So they always get their own detached session. The size is deliberately
# ordinary rather than huge: capture-pane hard-wraps at the pane width, and a
# very wide window hides wrapping bugs instead of catching them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "⚠️  tmux is not installed — running the suites directly, which will skip them."
  cd "$HERE" && exec node --test --test-concurrency=1 test/integration/*.test.ts
fi

SESSION="pi-subagents-it-$$"
LOG="$(mktemp -t pi-integration-XXXXXX.log)"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$LOG" "$LOG.status"
}
trap cleanup EXIT

tmux new-session -d -s "$SESSION" -x 120 -y 40 \
  "cd '$HERE' && node --test --test-concurrency=1 test/integration/*.test.ts > '$LOG' 2>&1; \
   echo \$? > '$LOG.status'; tmux wait-for -S '$SESSION-done'"
tmux wait-for "$SESSION-done"

cat "$LOG"
exit "$(cat "$LOG.status" 2>/dev/null || echo 1)"
