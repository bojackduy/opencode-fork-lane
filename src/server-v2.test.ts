import { describe, expect, test } from "bun:test"
import os from "node:os"
import plugin from "./server"

describe("Server dual export", () => {
  test("exposes id, server, and setup from a single default export", () => {
    expect(plugin.id).toBe("fork-lane")
    expect(typeof (plugin as any).server).toBe("function")
    expect(typeof (plugin as any).setup).toBe("function")
  })
})

describe("Server v2 setup", () => {
  test("registers fork_lane + lane and disposes the registration", async () => {
    const toolIDs: string[] = []
    let disposed = false
    const context = {
      location: { directory: os.tmpdir() },
      session: {},
      tool: {
        async transform(callback: (editor: { add(tool: { name: string }): void }) => void) {
          callback({ add: (t) => void toolIDs.push(t.name) })
          return {
            async dispose() {
              disposed = true
            },
          }
        },
      },
    }

    const cleanup = await (plugin as any).setup(context)
    try {
      expect(toolIDs.sort()).toEqual(["fork_lane", "lane"])
    } finally {
      await cleanup()
    }
    expect(disposed).toBe(true)
  })
})
