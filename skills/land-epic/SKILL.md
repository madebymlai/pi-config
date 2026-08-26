---
name: land-epic
description: Take an epic's tickets from ready to merged, working the frontier with parallel implementers.
disable-model-invocation: true
---

# Land Epic

Take an epic from tickets to merged. This ends with the work on the base branch, not with a pull request someone else has to finish.

## What you are working

The tickets are not a list, they are a task graph. Blocking edges mean that at any moment some tickets have every blocker closed and can start right now, in parallel, and `bd ready` is what computes that **frontier**. Working the frontier instead of the list is the whole source of the concurrency here.

Keep what crosses between you and a subagent thin. Send **pointers**: the epic id, the ticket id, the path to the exploration notes, the commit that landed the last slice. A subagent that needs the ticket reads the ticket, and restating it in the brief only creates a second copy that can go stale.

## Branch from where you are

Branch from the branch currently checked out. Whatever the user has checked out is the base they chose, and quietly re-basing onto the default branch is the kind of helpfulness that costs an afternoon. Open a draft pull request against that same base.

## Explore once, not once per ticket

When the tickets need groundwork, dispatch one scout before any implementation starts and have it write its notes to a path outside the repository, where every later subagent can read them. Done once, that keeps implementers implementing rather than each rediscovering the same map, and it keeps the exploration out of the branch.

## Work the frontier

Give each ticket on the frontier its own worker, its own git worktree, and its own branch, and launch them together rather than one at a time. Create the worktree first and pass it as the subagent's `cwd`, since a worktree is a directory to work in rather than something the spawn creates for you.

Results arrive on their own as each worker finishes, so there is nothing to poll. When one lands, merge its branch into the pull request branch, then ask `bd ready` again. Closing a ticket usually unblocks others, and those go out immediately as the next wave. Repeat until `bd ready` comes back empty and every ticket under the epic is closed.

A worker that reports back blocked has hit something only you can settle. Answer it, or narrow its ticket, before spawning anything that depends on it.

## Review, then land

Dispatch the reviewer against the pull request branch. Hand it the base branch and the epic, and let it pull the diff itself rather than passing it your account of what was built.

Fix what comes back in a single worker rather than one per finding, since the findings share context and a second reviewer pass is cheaper than five merges. Send the reviewer back over the result. When it returns clean, merge the pull request branch into the base you started from.

## Leave nothing behind

Remove every worktree you created and delete the branches that have merged. Close the tickets and the epic, each with the reason that closes it. Report what landed, what the reviewer caught, and anything you left open.
