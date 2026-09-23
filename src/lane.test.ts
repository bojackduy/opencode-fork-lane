import { describe, expect, test } from "bun:test"
import { formatBytes, sessionTitleFor, slugify, validateLaneName } from "./shared/lane"
import { candidateBases, classifyMoveError, hostPort, moveEndpoint } from "./shared/move"

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

describe("classifyMoveError", () => {
  test("known server messages", () => {
    expect(classifyMoveError("Destination directory belongs to another project").kind).toBe("project-mismatch")
    expect(classifyMoveError("Unable to apply your changes in the destination directory. The files may conflict.").kind).toBe(
      "apply-conflict",
    )
    expect(classifyMoveError("Session not found: ses_abc").kind).toBe("not-found")
    expect(classifyMoveError("Source is not a Git repository").kind).toBe("not-git")
    expect(classifyMoveError("moveSession HTTP 400 via 127.0.0.1:1: bad").kind).toBe("http")
  })
  test("connection failures incl. the real 0.2.3 report", () => {
    expect(classifyMoveError("moveSession fetch failed: Unable to connect. Is the computer able to access the url?").kind).toBe(
      "unreachable",
    )
    expect(classifyMoveError("fetch failed: ECONNREFUSED").kind).toBe("unreachable")
  })
  test("every kind carries a remedy", () => {
    for (const msg of ["belongs to another project", "Unable to apply your changes", "Session not found", "boom"]) {
      const { remedy } = classifyMoveError(msg)
      expect(remedy.length).toBeGreaterThan(10)
    }
  })
})

describe("candidateBases", () => {
  test("wildcard bind swaps to loopback, original first", () => {
    const bases = candidateBases("http://0.0.0.0:4096/")
    expect(bases[0]).toBe("http://0.0.0.0:4096")
    expect(bases).toContain("http://127.0.0.1:4096")
  })
  test("localhost gains a 127.0.0.1 fallback", () => {
    const bases = candidateBases("http://localhost:4096")
    expect(bases[0]).toBe("http://localhost:4096")
    expect(bases).toContain("http://127.0.0.1:4096")
  })
  test("plain loopback has no duplicate", () => {
    const bases = candidateBases("http://127.0.0.1:4096/")
    expect(bases).toEqual(["http://127.0.0.1:4096", "http://localhost:4096"])
  })
  test("empty and garbage", () => {
    expect(candidateBases("")).toEqual([])
    expect(candidateBases("not-a-url")).toEqual(["not-a-url"])
  })
})

describe("moveEndpoint", () => {
  test("body-only route, no query", () => {
    expect(moveEndpoint("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096/experimental/control-plane/move-session")
    expect(hostPort("http://127.0.0.1:4096/")).toBe("127.0.0.1:4096")
  })
})
