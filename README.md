# opencode-fork-lane

Fork-lane for OpenCode — **lane-inspired copy-on-write git worktrees + session fork**.

`/fork-lane` behaves like native `/fork` (history preserved, new session titled with your lane name) **plus** a lane-style worktree: new git branch + new disk folder with `node_modules` / `target/` / `.env` cloned **by reference** (reflink) so the new tree starts warm. Inspired by [lane](https://lane.lukeed.com/).

- **TUI:** `/fork-lane` asks for a name (that becomes branch + folder + session title), creates the worktree, forks the session, moves the fork into the new worktree, and navigates to it.
- **Agent:** `fork_lane` tool so the agent can isolate risky / parallel / experimental work itself.

## Install

Install from npm (published as `@bojackduy/opencode-fork-lane`). The same
package provides both the server plugin and the TUI plugin — opencode resolves
the right entrypoint (`./server` / `./tui`) from the config file it appears in:

```jsonc
// opencode.jsonc
{
  "plugin": ["@bojackduy/opencode-fork-lane"]
}
```

```jsonc
// tui.json
{
  "plugin": ["@bojackduy/opencode-fork-lane"]
}
```

> To use a local clone instead (development):
>
> ```jsonc
> // opencode.jsonc
> { "plugin": ["/path/to/opencode-fork-lane/src/server.ts"] }
> // tui.json
> { "plugin": ["/path/to/opencode-fork-lane/src/tui.tsx"] }
> ```

Then quit and restart opencode (config is loaded once at startup).

Requires: git, bun >= 1.1, opencode >= 1. Optional but recommended: [`lane`](https://lane.lukeed.com/) binary (`curl -fsSL https://lane.lukeed.com | sh`) — when present we delegate `lane new` for full fidelity; otherwise we do git + reflink ourselves.

## Use

### TUI — `/fork-lane`

1. Open a session.
2. Run `/fork-lane` (or `<leader>f`).
3. Pick what to fork — **Full session** or a specific prompt (same choice native fork gives you).
4. Enter a lane name, e.g. `fix-login`.
5. You land in a forked session titled `fix-login`, rooted at `<gitRoot>/.lane/trees/fix-login` on branch `fix-login`.

### Agent — `fork_lane`

```
fork_lane(name="fix-login", task="Make verify constant-time, keep signature")
```

- `name` (required): branch + folder + session title (slugified).
- `task` (optional): handoff line posted into the fork.
- `base` (optional): git ref to branch from.
- `messageID` (optional): fork at a message instead of full history.
- `moveChanges` (default true): best-effort `move-session` with uncommitted changes.

Returns JSON: `{ ok, name, branch, directory, via, forkedSession, moved, moveDetail, next }`.

- `moved: true` — fork now lives in the new worktree. Continue there.
- `moved: false` — fork holds history but is still rooted at the old directory (older server / move failed). Do new edits with **absolute paths** under `directory`; human can TUI → Move session → `directory`, or re-run `/fork-lane` (TUI moves correctly).

## How it works (lane-like)

| | `git worktree add` | `lane new` / `fork-lane` |
|---|---|---|
| tracked files | checked out | checked out |
| `node_modules`, `target/`, `.env` (any depth) | absent | **exists, by reference** |
| uncommitted work | absent | with `moveChanges` |
| cost | reinstall + cold build | ~0 B, warm cache |

- Worktree location follows lane: `<gitRoot>/.lane/trees/<name>`, branch `<name>`.
- Reflink: APFS `cp -cR`, Linux `cp --reflink=always -a`, else plain copy fallback. `lane new` is preferred when the binary exists.
- Session: `session.fork` (history) → `session.update` (title = name) → `experimental.controlPlane.moveSession` (directory = new worktree). Server tool falls back to raw `POST /experimental/control-plane/move-session` and degrades gracefully.

## Why not just `lane new` + `opencode`?

You can — and should, when you want a bare terminal lane. `fork-lane` is for when the **conversation** should move with the checkout: same history, new branch, warm cache, one command, plus an agent-callable equivalent so the model can isolate itself without asking you to run shell commands.

## Limits

- Git repos only (worktrees require git).
- `moveSession` requires a recent opencode server with the experimental control-plane route and same-project directories. Cross-project moves are rejected (same as native Move session).
- Direct `lane` memory (`lane note` / `lane why`) is out of scope for v0.1 — the worktree layout (`.lane/trees/`) is compatible, so you can `lane note` inside the lane normally.

## Dev

```sh
bun install
bun run typecheck
bun test
bun run build
```
