# Changelog

## 0.2.1

- Docs site (`docs/`, served via GitHub Pages) with SEO meta, comparison table, install guide, and FAQ; SEO pass over the README (badges, FAQ, links).
- Package metadata: `homepage` points at the docs site, landing page ships inside the npm tarball.

## 0.2.0

- `/fork-lane` fork point picker: choose full session or a specific prompt before naming the lane, mirroring the native fork dialog. The `fork_lane` agent tool already accepted `messageID`; the TUI now uses it too.
- Multi-line colored helper in the lane-name prompt (branch / folder / session mapping, fork scope, reflink note), theme-aware via `api.theme`.
- Docs site (`docs/`, served via GitHub Pages) with SEO meta, comparison table, install guide, and FAQ; SEO pass over the README (badges, FAQ, links).


Initial release.

- `/fork-lane` TUI command (also `<leader>f`): prompts for a lane name, creates a lane-style copy-on-write git worktree (`.lane/trees/<name>`, branch `<name>`), forks the current session with history, titles the fork with the lane name, moves it into the new worktree via `experimental.controlPlane.moveSession`, and navigates to it. Fork point picker (full session or a specific prompt) mirrors the native fork dialog.
- `fork_lane` agent tool: same worktree + fork flow, callable by the agent itself (`name` required; optional `task`, `base`, `messageID`, `moveChanges`). Best-effort move with graceful fallback to absolute-path instructions when the move route is unavailable.
- Worktree engine delegates to the `lane` binary when installed (`lane new`), otherwise `git worktree add` plus reflink cloning of git-ignored paths (APFS `cp -cR`, Linux `cp --reflink=always -a`, plain-copy fallback).
