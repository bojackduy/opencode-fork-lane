# Changelog

## 0.1.0

Initial release.

- `/fork-lane` TUI command (also `<leader>f`): prompts for a lane name, creates a lane-style copy-on-write git worktree (`.lane/trees/<name>`, branch `<name>`), forks the current session with history, titles the fork with the lane name, moves it into the new worktree via `experimental.controlPlane.moveSession`, and navigates to it. Fork point picker (full session or a specific prompt) mirrors the native fork dialog.
- `fork_lane` agent tool: same worktree + fork flow, callable by the agent itself (`name` required; optional `task`, `base`, `messageID`, `moveChanges`). Best-effort move with graceful fallback to absolute-path instructions when the move route is unavailable.
- Worktree engine delegates to the `lane` binary when installed (`lane new`), otherwise `git worktree add` plus reflink cloning of git-ignored paths (APFS `cp -cR`, Linux `cp --reflink=always -a`, plain-copy fallback).
