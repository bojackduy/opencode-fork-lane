import { describe, expect, test } from "bun:test"
import { formatBytes, sessionTitleFor, slugify, validateLaneName } from "./shared/lane"

describe("slugify", () => {
  test("basic", () => {
    expect(slugify("Fix-Login")).toBe("fix-login")
    expect(slugify("  agent b  ")).toBe("agent-b")
    expect(slugify("feat/auth_v2!!")).toBe("feat/auth-v2")
  })
  test("slashes preserved", () => {
    expect(slugify("feat/login")).toBe("feat/login")
    expect(slugify("Feat / Login")).toBe("feat/login")
    expect(slugify("a/b/c")).toBe("a/b/c")
    expect(slugify("feat//login")).toBe("feat/login")
  })
  test("throws on empty", () => {
    expect(() => slugify("!!!")).toThrow()
    expect(() => slugify("")).toThrow()
    expect(() => slugify("/")).toThrow()
  })
})

describe("validateLaneName", () => {
  test("ok", () => {
    expect(validateLaneName("fix-login")).toBe("fix-login")
    expect(validateLaneName("feat/login")).toBe("feat/login")
  })
  test("too short", () => {
    expect(() => validateLaneName("a")).toThrow()
  })
  test("normalizes slashes", () => {
    expect(validateLaneName("/feat")).toBe("feat")
    expect(validateLaneName("feat//login")).toBe("feat/login")
  })
})

describe("sessionTitleFor", () => {
  test("slash adapted", () => {
    expect(sessionTitleFor("feat/login")).toBe("feat — login")
    expect(sessionTitleFor("a/b/c")).toBe("a — b — c")
    expect(sessionTitleFor("fix-login")).toBe("fix-login")
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
