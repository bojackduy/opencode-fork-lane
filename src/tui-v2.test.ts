import { describe, expect, test } from "bun:test"
import plugin from "./tui"

describe("TUI dual export", () => {
  test("exposes id, tui, and setup from a single default export", () => {
    expect(plugin.id).toBe("fork-lane")
    expect(typeof (plugin as any).tui).toBe("function")
    expect(typeof (plugin as any).setup).toBe("function")
  })
})

describe("TUI v2 setup", () => {
  test("claims the app slot for keymap and releases it on cleanup", async () => {
    const slots: unknown[] = []
    let released = 0
    const ctx = {
      location: { directory: "/tmp" },
      client: {},
      theme: {},
      ui: {
        slot: (claim: unknown) => {
          slots.push(claim)
          return () => void released++
        },
        router: { current: () => ({ type: "home" }) },
        toast: { show: () => {} },
        dialog: {},
      },
      keymap: { layer: () => {}, mode: { push: () => () => {} } },
      data: { location: { default: () => ({ directory: "/tmp" }) } },
    }

    const cleanup = await (plugin as any).setup(ctx)
    try {
      expect(typeof cleanup).toBe("function")
      expect(slots.map((s: any) => s.append)).toEqual(["app"])
    } finally {
      await cleanup()
    }
    expect(released).toBe(1)
    await cleanup()
  })
})
