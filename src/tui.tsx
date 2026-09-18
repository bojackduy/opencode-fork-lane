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

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function fmtTime(created: number): string {
  try {
    return new Date(created).toLocaleString()
  } catch {
    return ""
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
    pickForkPoint(sessionID, cwd)
  }

  // Step 1 (native fork parity): choose which prompt to fork from —
  // full session or a specific user message — then ask for the lane name.
  function pickForkPoint(sessionID: string, cwd: string) {
    let messages: Array<{ id: string; text: string; created: number }> = []
    try {
      const all = api.state.session.messages(sessionID) as any[]
      for (const m of all) {
        if (m?.role !== "user") continue
        const parts = (api.state.part(m.id) as any[]) ?? []
        const text = parts
          .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => p.text ?? "")
          .join("")
          .trim()
        if (!text) continue
        messages.push({ id: m.id, text, created: m?.time?.created ?? 0 })
      }
    } catch {}
    messages = messages.reverse()

    if (messages.length === 0) {
      askName(sessionID, cwd, undefined)
      return
    }

    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Fork lane from…"
        placeholder="Full session or pick a prompt"
        options={[
          { title: "Full session", value: undefined, description: "fork with complete history" },
          ...messages.map((m) => ({
            title: preview(m.text),
            value: m.id as string | undefined,
            footer: m.created ? fmtTime(m.created) : undefined,
          })),
        ]}
        onSelect={(opt) => askName(sessionID, cwd, opt?.value)}
      />
    ))
  }

  // Step 2: lane name becomes branch + folder + session title.
  function askName(sessionID: string, cwd: string, messageID: string | undefined) {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Fork lane"
        placeholder="fix-login"
        description={() => {
          const t = api.theme.current
          return (
            <box flexDirection="column">
              <text fg={t.textMuted}>Lane name becomes:</text>
              <text>
                <span style={{ fg: t.accent }}>{"  branch  → "}</span>
                <span style={{ fg: t.text }}>&lt;name&gt;</span>
              </text>
              <text>
                <span style={{ fg: t.accent }}>{"  folder  → "}</span>
                <span style={{ fg: t.text }}>.lane/trees/&lt;name&gt;</span>
              </text>
              <text>
                <span style={{ fg: t.accent }}>{"  session → "}</span>
                <span style={{ fg: t.text }}>titled &lt;name&gt;</span>
              </text>
              <text fg={t.textMuted}>{messageID ? "History forked from the selected prompt." : "Full history forked."}</text>
              <text fg={t.textMuted}>Worktree is copy-on-write (reflink when possible).</text>
            </box>
          )
        }}
        onConfirm={(value) => void run(value, sessionID, cwd, messageID)}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  async function run(rawName: string, sessionID: string, cwd: string, messageID: string | undefined) {
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

      // Fork (history preserved, up to the selected prompt when given).
      const forked: any = await (api.client as any).session.fork(
        messageID ? { sessionID, messageID } : { sessionID },
      )
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
