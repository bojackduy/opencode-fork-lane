import { describe, expect, test } from "bun:test"
import { formatBytes, slugify, validateLaneName } from "./shared/lane"

describe("slugify", () => {
  test("basic", () => {
    expect(slugify("Fix-Login")).toBe("fix-login")
    expect(slugify("  agent b  ")).toBe("agent-b")
    expect(slugify("feat/auth_v2!!")).toBe("feat-auth-v2")
  })
  test("throws on empty", () => {
    expect(() => slugify("!!!")).toThrow()
    expect(() => slugify("")).toThrow()
  })
})

describe("validateLaneName", () => {
  test("ok", () => {
    expect(validateLaneName("fix-login")).toBe("fix-login")
  })
  test("too short", () => {
    expect(() => validateLaneName("a")).toThrow()
  })
})

describe("formatBytes", () => {
  test("units", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1536)).toBe("1.5 KiB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB")
    expect(formatBytes(-1)).toBe("n/a")
  })
})
