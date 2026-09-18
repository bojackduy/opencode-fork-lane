/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createLaneWorktree, formatBytes, validateLaneName } from "./shared/lane"

const PLUGIN_ID = "fork-lane"

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    const o = e as any
    if (o?.error) return typeof o.error === "string" ? o.error : JSON.stringify(o.error).slice(0, 400)
    if (o?.data?.message) return String(o.data.message)
    return JSON.stringify(e).slice(0, 400)
  } catch {
    return String(e)
  }
}

const tui: TuiPlugin = async (api) => {
  const open = () => {
    const current = api.route.current
    const sessionID = current.name === "session" ? (current.params as any)?.sessionID as string | undefined : undefined
    if (!sessionID) {
      api.ui.toast({ variant: "error", title: "fork-lane", message: "Open a session first, then /fork-lane." })
      return
    }
    const cwd = api.state.path.directory

    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Fork lane"
        placeholder="fix-login"
        description={() => (
          <text>
            Lane name becomes branch + folder (.lane/trees/&lt;name&gt;) + session title. History is forked, worktree is copy-on-write (reflink when
            possible).
          </text>
        )}
        onConfirm={(value) => void run(value, sessionID, cwd)}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  async function run(rawName: string, sessionID: string, cwd: string) {
    let slug: string
    try {
      slug = validateLaneName(rawName)
    } catch (e) {
      api.ui.toast({ variant: "error", title: "fork-lane", message: errText(e) })
      api.ui.dialog.clear()
      return
    }
    // Busy state: replace prompt with working indicator.
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt title={`Fork lane "${slug}"`} busy busyText={`Creating worktree + forking…`} onConfirm={() => {}} onCancel={() => {}} />
    ))
    // Let the busy dialog paint before blocking on git/reflink.
    await new Promise((r) => setTimeout(r, 50))

    try {
      const lane = createLaneWorktree({ cwd, name: slug })

      // Fork (history preserved).
      const forked: any = await (api.client as any).session.fork({ sessionID })
      if (forked?.error) throw new Error(errText(forked.error))
      const newID: string | undefined = forked?.data?.id ?? forked?.id
      if (!newID) throw new Error("fork response contained no session ID")

      try {
        await (api.client as any).session.update({ sessionID: newID, title: slug })
      } catch {}

      // Move the fork into the new worktree (the part `session.fork` can't do).
      let moved = false
      let moveDetail = ""
      try {
        const res: any = await (api.client as any).experimental.controlPlane.moveSession({
          sessionID: newID,
          destination: { directory: lane.directory },
          moveChanges: true,
        })
        if (res?.error) {
          moveDetail = errText(res.error)
        } else {
          moved = true
        }
      } catch (e) {
        moveDetail = errText(e)
      }

      api.ui.dialog.clear()
      // Navigate to the fork (like native fork UX).
      try {
        ;(api.route as any).navigate("session", { sessionID: newID })
      } catch {
        try {
          ;(api.route as any).navigate({ type: "session", sessionID: newID })
        } catch {}
      }
      api.ui.toast({
        variant: moved ? "success" : "warning",
        title: moved ? `Fork-lane "${slug}"` : `Fork "${slug}" (unmoved)`,
        message: moved
          ? `${lane.directory} (${lane.branch}, ${lane.via}${lane.ignoredCloned >= 0 ? `, ${lane.ignoredCloned} ignored, ${formatBytes(lane.ignoredBytes)}` : ""})`
          : `Worktree ready at ${lane.directory} but move failed: ${moveDetail.slice(0, 160)}. Use Move session → ${lane.directory}.`,
      })
    } catch (e) {
      api.ui.dialog.clear()
      api.ui.toast({ variant: "error", title: "fork-lane failed", message: errText(e).slice(0, 400) })
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "fork-lane.run",
        title: "Fork lane",
        category: "Session",
        namespace: "palette",
        slashName: "fork-lane",
        run: open,
      },
    ],
    bindings: [{ key: "<leader>f", cmd: "fork-lane.run", desc: "Fork into lane worktree" }],
  })

  api.lifecycle.onDispose(() => {})
}

export default {
  id: PLUGIN_ID,
  tui,
} satisfies TuiPluginModule & { id: string }
