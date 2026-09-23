# Changelog

## 0.3.1

- **Fix silent move failures (agent tool)**: every server-tool move failed with `moveSession fetch failed: Unable to connect` — raw `fetch` to `serverUrl` never connected (unconnectable host such as a wildcard bind), while the TUI path (in-process client) worked. The tool now retries loopback-swapped bases (`0.0.0.0`/`::`/`localhost` → `127.0.0.1` and back), sends a body-only POST exactly like the v2 SDK client (no `?directory` query), and times out after 15s per candidate.
- **No more "can't move, don't know why"**: move failures return classified `moveKind` (`unreachable` / `project-mismatch` / `apply-conflict` / `not-found` / `not-git` / `http`) plus a `moveRemedy`, with the attempted host:ports in `moveDetail`. TUI toasts upgraded from truncated warning to full error + remedy.

## 0.2.3

- **Naming aliases**: agent tool now registered as both `fork_lane` (primary) and `lane` (alias, same behavior) so "lane", "fork lane", "fork-lane", or "worktree" all resolve instead of "tool not found". TUI now exposes both `/fork-lane` and `/lane` palette slashes (`fork-lane.run` + `lane.run`) to the same flow. Tool description advertises the aliases for model discovery.

## 0.2.2

- **Slash in lane names**: branch and folder now keep "/" (e.g. "feat/login" → branch "feat/login", folder ".lane/trees/feat/login"). Session title adapts "/" → " — " ("feat — login") for readability. Previously "/" was stripped to "-".
- **Hotkey collision fix**: default TUI binding moved from `<leader>f` (collided with telescope) to `ctrl+f`. The palette slash `/fork-lane` is always the conflict-free entry point. Context note: opencode has no plugin-keymap collision API — plugins register layers independently, so we pick a non‑overlapping default and you can rebind via `tui.jsonc` keybinds if needed (see README).

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
