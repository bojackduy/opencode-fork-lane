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

const server: Plugin = async ({ client, directory, serverUrl }) => {
  return {
    tool: {
      fork_lane: tool({
        description:
          "Fork into a lane: create a lane-style copy-on-write git worktree (new branch + new folder, reflink for node_modules/target/.env when possible) AND fork the current session with history. " +
          "Use when you want to isolate risky/experimental/parallel work without polluting the main checkout. " +
          "The lane name becomes the git branch, the worktree folder name, and the forked session title. " +
          "After success, do new work under the returned directory (absolute paths). If `moved` is false, the fork still holds full history in the old directory — prefer absolute paths under the new worktree for file edits.",
          args: {
          name: tool.schema.string().describe('Lane name — branch + folder + session title. Branch/folder keep "/" (e.g. "feat/login"); session title uses " — " for "/" . Slugified, min 2 chars.'),
          task: tool.schema.string().optional().describe("What the lane should do. Posted as the first handoff message in the fork so the continuation has context."),
          base: tool.schema.string().optional().describe("Git ref the lane branches from (lane --base). Defaults to current HEAD."),
          messageID: tool.schema.string().optional().describe("Fork at a specific message ID instead of full history (same as /fork from a message)."),
          moveChanges: tool.schema.boolean().optional().describe("Move uncommitted changes into the lane via move-session (default true). Set false to keep the old checkout dirty and lane clean."),
        },
        execute: async (args, context) => {
          const sessionID = (context as any)?.sessionID as string | undefined
          if (!sessionID) {
            return { title: "No session", output: "fork_lane needs a session context (call from an active OpenCode session)." }
          }
          let slug: string
          try {
            slug = validateLaneName(args.name)
          } catch (e) {
            return { title: "Invalid name", output: describeError(e) }
          }
          const cwd = (context as any)?.directory as string | undefined ?? directory
          const moveChanges = args.moveChanges ?? true

          // 1) Worktree (lane-style). This is the fallible disk part — do it first.
          let lane: Awaited<ReturnType<typeof createLaneWorktree>>
          try {
            lane = createLaneWorktree({ cwd, name: slug, base: args.base })
          } catch (e) {
            return { title: "Worktree failed", output: `fork-lane worktree failed: ${describeError(e)}` }
          }

          // 2) Fork session (history preserved, same directory for now).
          let forkedID: string | undefined
          try {
            const body: any = {}
            if (args.messageID) body.messageID = args.messageID
            // v1 shape: { path: { id }, body }. Be liberal for forward-compat.
            const res: any = await (client as AnyClient).session.fork(
              Object.keys(body).length ? { path: { id: sessionID }, body } : { path: { id: sessionID } },
            )
            const err = sdkError(res)
            if (err) throw new Error(err)
            forkedID = res?.data?.id ?? res?.id
            if (!forkedID) throw new Error("fork response contained no session ID")
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
            await (client as AnyClient).session.update({ path: { id: forkedID }, body: { title: sessionTitleFor(slug) } })
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
            `\nDo new work under ${lane.directory} (absolute paths).`
          try {
            await (client as AnyClient).session.promptAsync?.({
              path: { id: forkedID },
              body: { parts: [{ type: "text", text: handoff }] },
            })
          } catch {
            try {
              await (client as AnyClient).session.prompt?.({
                path: { id: forkedID },
                body: { parts: [{ type: "text", text: handoff }] },
              })
            } catch {}
          }

          // 5) Best-effort move of the fork into the new worktree.
          const move = await tryMoveSession({
            client: client as AnyClient,
            serverUrl: serverUrl as unknown as URL | undefined,
            directory: cwd,
            sessionID: forkedID,
            destination: lane.directory,
            moveChanges,
          })

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
        },
      }),
    },
  }
}

export default {
  id: PLUGIN_ID,
  server,
}
