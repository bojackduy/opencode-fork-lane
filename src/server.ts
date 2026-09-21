// ─── fork-lane: server plugin ────────────────────────────────────────────────
// Agent-callable `fork_lane` tool: lane-style worktree + session fork.
//
// Flow (public APIs only, no DB hacks):
//   1. Create lane worktree (lane binary if present, else git + reflink).
//   2. Fork current session (history preserved) and title it with lane name.
//   3. Best-effort move of the forked session into the new worktree via
//      POST /experimental/control-plane/move-session (v2 route). The v1 SDK
//      client has no moveSession helper, so we call the HTTP route directly
//      with the plugin's serverUrl + directory routing. If the move fails
//      (older server, auth, cross-project), we still return success: the fork
//      holds history and the worktree is ready — the agent continues with
//      absolute paths under the new directory, and the human can Move session
//      from the TUI or re-run /fork-lane (TUI moves correctly).
//
// The tool is intentionally agent-first: `name` is required (lane + session
// title), `task` seeds the handoff message posted into the fork.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { createLaneWorktree, formatBytes, sessionTitleFor, validateLaneName } from "./shared/lane"

const PLUGIN_ID = "fork-lane"

type AnyClient = any

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e).slice(0, 500)
  } catch {
    return String(e)
  }
}

function sdkError(res: any): string | undefined {
  const err = res?.error
  if (!err) return undefined
  if (typeof err === "string") return err
  if (typeof err?.message === "string") return err.message
  if (typeof err?.data?.message === "string") return err.data.message
  try {
    return JSON.stringify(err).slice(0, 500)
  } catch {
    return String(err)
  }
}

async function tryMoveSession(opts: {
  client: AnyClient
  serverUrl: URL | undefined
  directory: string
  sessionID: string
  destination: string
  moveChanges: boolean
}): Promise<{ moved: boolean; detail: string }> {
  // 1) v2-style client with controlPlane helper (TUI Api has it; be liberal).
  try {
    const cp = opts.client?.controlPlane ?? opts.client?.controlplane ?? opts.client?.v2?.controlPlane
    if (cp?.moveSession) {
      const res = await cp.moveSession({ sessionID: opts.sessionID, destination: { directory: opts.destination }, moveChanges: opts.moveChanges })
      const err = sdkError(res)
      if (!err) return { moved: true, detail: "via client.controlPlane.moveSession" }
      return { moved: false, detail: `controlPlane.moveSession: ${err}` }
    }
  } catch (e) {
    // fall through to raw HTTP
  }
  // 2) Raw HTTP to the experimental route using the plugin server URL.
  //    Auth: server plugins run in-process; the route accepts localhost without
  //    extra headers in default installs. Include directory routing as query.
  try {
    if (!opts.serverUrl) return { moved: false, detail: "no serverUrl for raw moveSession" }
    const base = opts.serverUrl.toString().replace(/\/$/, "")
    const url = `${base}/experimental/control-plane/move-session?directory=${encodeURIComponent(opts.directory)}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: opts.sessionID,
        destination: { directory: opts.destination },
        moveChanges: opts.moveChanges,
      }),
    })
    if (res.ok) return { moved: true, detail: "via POST /experimental/control-plane/move-session" }
    const text = await res.text().catch(() => "")
    return { moved: false, detail: `moveSession HTTP ${res.status}: ${text.slice(0, 300)}` }
  } catch (e) {
    return { moved: false, detail: `moveSession fetch failed: ${describeError(e)}` }
  }
}

// Session operations behind the lane flow. v1 and v2 differ in client
// shapes (v1: { path, body } envelopes; v2: flat inputs + native move), so
// each entry builds its own ops and shares runForkLane below.
type SessionOps = {
  fork: (input: { sessionID: string; messageID?: string }) => Promise<{ id: string; historyPreserved: boolean }>
  updateTitle: (sessionID: string, title: string) => Promise<void>
  prompt: (sessionID: string, text: string) => Promise<void>
  move: (sessionID: string, directory: string, moveChanges: boolean) => Promise<{ moved: boolean; detail: string }>
}

type LaneArgs = { name: string; task?: string; base?: string; messageID?: string; moveChanges?: boolean }

async function runForkLane(
  args: LaneArgs,
  execCtx: { sessionID?: string; directory?: string },
  ops: SessionOps,
  fallbackDir: string,
  makeWorktree: (cwd: string, slug: string) => Awaited<ReturnType<typeof createLaneWorktree>>,
) {
  const sessionID = execCtx.sessionID
  if (!sessionID) {
    return { title: "No session", output: "fork_lane needs a session context (call from an active OpenCode session)." }
  }
  let slug: string
  try {
    slug = validateLaneName(args.name)
  } catch (e) {
    return { title: "Invalid name", output: describeError(e) }
  }
  const cwd = execCtx.directory ?? fallbackDir
  const moveChanges = args.moveChanges ?? true

  // 1) Worktree (lane-style). This is the fallible disk part — do it first.
  let lane: Awaited<ReturnType<typeof createLaneWorktree>>
  try {
    lane = makeWorktree(cwd, slug)
  } catch (e) {
    return { title: "Worktree failed", output: `fork-lane worktree failed: ${describeError(e)}` }
  }

  // 2) Fork session (history preserved, same directory for now).
  let forkedID: string | undefined
  let historyPreserved = true
  try {
    const forked = await ops.fork({ sessionID, messageID: args.messageID })
    forkedID = forked.id
    historyPreserved = forked.historyPreserved
  } catch (e) {
    return {
      title: "Worktree ready, fork failed",
      output: JSON.stringify(
        {
          ok: false,
          name: slug,
          branch: lane.branch,
          directory: lane.directory,
          gitRoot: lane.gitRoot,
          via: lane.via,
          forkError: describeError(e),
          next: `Worktree is ready at ${lane.directory} (branch ${lane.branch}). Fork failed — continue with: opencode --continue ${sessionID} (or retry fork_lane).`,
        },
        null,
        2,
      ),
    }
  }

  // 3) Title the fork with the lane name (TUI asks for name → session name).
  // Slash in lane name is kept for branch/worktree, session title gets " — " for "/" readability.
  try {
    await ops.updateTitle(forkedID, sessionTitleFor(slug))
  } catch {
    // non-fatal
  }

  // 4) Handoff message so the fork knows its lane.
  const handoff =
    `Fork-lane "${slug}" ready.\n` +
    `- branch: ${lane.branch}\n` +
    `- directory: ${lane.directory}\n` +
    `- via: ${lane.via}${lane.ignoredCloned >= 0 ? ` (${lane.ignoredCloned} ignored paths, ${formatBytes(lane.ignoredBytes)})` : ""}\n` +
    (args.task ? `- task: ${args.task}\n` : "") +
    (historyPreserved ? "" : `- note: history was NOT carried over on this runtime; the task above is the full context.\n`) +
    `\nDo new work under ${lane.directory} (absolute paths).`
  try {
    await ops.prompt(forkedID, handoff)
  } catch {
    // non-fatal
  }

  // 5) Best-effort move of the fork into the new worktree.
  const move = await ops
    .move(forkedID, lane.directory, moveChanges)
    .catch((e) => ({ moved: false, detail: describeError(e) }))

  const out = {
    ok: true,
    name: slug,
    branch: lane.branch,
    directory: lane.directory,
    gitRoot: lane.gitRoot,
    via: lane.via,
    reflink: lane.reflink,
    ignoredCloned: lane.ignoredCloned,
    ignoredBytes: lane.ignoredBytes,
    historyPreserved,
    fromSession: sessionID,
    forkedSession: forkedID,
    moved: move.moved,
    moveDetail: move.detail,
    next: move.moved
      ? `Continue in forked session ${forkedID} — it now lives in ${lane.directory} (branch ${lane.branch}).`
      : `Fork ${forkedID} holds history (still rooted at old directory). Do new edits under ${lane.directory} with absolute paths (branch ${lane.branch}). Human: TUI /fork-lane moves correctly, or Move session → ${lane.directory}.`,
  }
  return {
    title: move.moved ? `Fork-lane "${slug}" → ${lane.directory}` : `Fork-lane "${slug}" (unmoved)`,
    output: JSON.stringify(out, null, 2),
  }
}

const DESCRIPTION =
  "Fork into a lane: create a lane-style copy-on-write git worktree (new branch + new folder, reflink for node_modules/target/.env when possible) AND fork the current session with history. " +
  "Use when you want to isolate risky/experimental/parallel work without polluting the main checkout. " +
  "The lane name becomes the git branch, the worktree folder name, and the forked session title. " +
  "After success, do new work under the returned directory (absolute paths). If `moved` is false, the fork still holds full history in the old directory — prefer absolute paths under the new worktree for file edits. " +
  "Aliases: this tool is also available as `lane` (same behavior). When the user says 'lane', 'fork lane', 'fork-lane', or 'worktree', call this tool."

const ARG_DEFS = {
  name: tool.schema.string().describe('Lane name — branch + folder + session title. Branch/folder keep "/" (e.g. "feat/login"); session title uses " — " for "/" . Slugified, min 2 chars.'),
  task: tool.schema.string().optional().describe("What the lane should do. Posted as the first handoff message in the fork so the continuation has context."),
  base: tool.schema.string().optional().describe("Git ref the lane branches from (lane --base). Defaults to current HEAD."),
  messageID: tool.schema.string().optional().describe("Fork at a specific message ID instead of full history (same as /fork from a message)."),
  moveChanges: tool.schema.boolean().optional().describe("Move uncommitted changes into the lane via move-session (default true). Set false to keep the old checkout dirty and lane clean."),
}

const server: Plugin = async ({ client, directory, serverUrl }) => {
  const ops: SessionOps = {
    async fork({ sessionID, messageID }) {
      const body: any = {}
      if (messageID) body.messageID = messageID
      // v1 shape: { path: { id }, body }. Be liberal for forward-compat.
      const res: any = await (client as AnyClient).session.fork(
        Object.keys(body).length ? { path: { id: sessionID }, body } : { path: { id: sessionID } },
      )
      const err = sdkError(res)
      if (err) throw new Error(err)
      const id = res?.data?.id ?? res?.id
      if (!id) throw new Error("fork response contained no session ID")
      return { id, historyPreserved: true }
    },
    async updateTitle(sessionID, title) {
      await (client as AnyClient).session.update({ path: { id: sessionID }, body: { title } })
    },
    async prompt(sessionID, text) {
      try {
        await (client as AnyClient).session.promptAsync?.({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text }] },
        })
      } catch {
        await (client as AnyClient).session.prompt?.({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text }] },
        })
      }
    },
    async move(sessionID, destination, moveChanges) {
      return tryMoveSession({
        client: client as AnyClient,
        serverUrl: serverUrl as unknown as URL | undefined,
        directory,
        sessionID,
        destination,
        moveChanges,
      })
    },
  }
  const execute = (args: LaneArgs, context: any) =>
    runForkLane(
      args,
      { sessionID: (context as any)?.sessionID, directory: (context as any)?.directory },
      ops,
      directory,
      (cwd, slug) => createLaneWorktree({ cwd, name: slug, base: args.base }),
    )
  return {
    tool: {
      // Primary name (snake_case, agent convention).
      fork_lane: tool({ description: DESCRIPTION, args: ARG_DEFS, execute }),
      // Alias so "lane", "use lane", "/lane" all resolve instead of "tool not found".
      lane: tool({ description: `${DESCRIPTION} (Alias of fork_lane.)`, args: ARG_DEFS, execute }),
    },
  }
}

// ─── V2 (opencode v2 core) ───────────────────────────────────────────────────
// The worktree half is runtime-agnostic (pure git/node). The session half maps
// to the v2 session domain: update/prompt/move exist with flat inputs; fork
// is probed at runtime (present in the underlying client, absent from the
// domain Pick) with a create+title fallback that preserves everything except
// history (flagged in the output).
function toV2Tool(
  id: string,
  description: string,
  execute: (args: LaneArgs, context: { sessionID: string; directory: string }) => Promise<{ title: string; output: string }>,
) {
  return {
    name: id,
    description,
    input: tool.schema.object(ARG_DEFS),
    async execute(input: unknown, context: { sessionID: string; directory?: string; worktree?: string }) {
      return execute(input as LaneArgs, {
        sessionID: context.sessionID,
        directory: context.directory ?? context.worktree ?? process.cwd(),
      })
    },
  }
}

const setup = async (context: V2Plugin.Context) => {
  const session = context.session as V2Plugin.Context["session"] & {
    fork?: (input: { sessionID: string; before?: string }) => Promise<{ id: string }>
    create?: (input: Record<string, unknown>) => Promise<{ id: string }>
  }
  const ops: SessionOps = {
    async fork({ sessionID, messageID }) {
      if (typeof session.fork === "function") {
        const res = await session.fork(messageID ? { sessionID, before: messageID } : { sessionID })
        const id = (res as { id?: string })?.id
        if (!id) throw new Error("fork response contained no session ID")
        return { id, historyPreserved: true }
      }
      const created = await session.create?.({
        title: `lane from ${sessionID.slice(0, 8)}`,
        location: { directory: context.location.directory },
      })
      const id = created?.id
      if (!id) throw new Error("v2 session domain exposes neither fork nor create")
      return { id, historyPreserved: false }
    },
    async updateTitle(sessionID, title) {
      await context.session.update({ sessionID, title } as never)
    },
    async prompt(sessionID, text) {
      await context.session.prompt({ sessionID, text } as never)
    },
    async move(sessionID, directory) {
      // v2 move has no moveChanges flag; the domain owns change handling.
      await context.session.move({ sessionID, directory } as never)
      return { moved: true, detail: "via v2 session.move" }
    },
  }
  const execute = (args: LaneArgs, execCtx: { sessionID: string; directory: string }) =>
    runForkLane(args, execCtx, ops, context.location.directory, (cwd, slug) =>
      createLaneWorktree({ cwd, name: slug, base: args.base }),
    )
  const registration = await context.tool.transform((editor) => {
    editor.add(toV2Tool("fork_lane", DESCRIPTION, execute))
    editor.add(toV2Tool("lane", `${DESCRIPTION} (Alias of fork_lane.)`, execute))
  })
  return () => registration.dispose()
}

// Dual export: the v1 loader reads `.server`, the v2 loader reads `.setup`,
// and each ignores the other's key. Exactly one export — v1 treats every named
// export as its own plugin, which would double-register the tools.
export default {
  id: PLUGIN_ID,
  server,
  setup,
}
