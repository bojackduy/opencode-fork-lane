// ─── fork-lane: shared lane-style worktree logic ─────────────────────────────
// Used by both server plugin (tool) and TUI plugin (slash command).
// Bun + Node compatible: only node:* imports, sync child_process for simplicity.
//
// lane-inspired copy-on-write:
//   1. `lane new <name>` if the lane binary is installed (full fidelity).
//   2. Else manual: `git worktree add` + reflink-clone of every git-ignored
//      path (node_modules, target/, .env, …) so the new tree starts warm.
//      - macOS (APFS): `cp -cR` (clonefile)
//      - Linux (btrfs/XFS/bcachefs): `cp --reflink=always -a`
//      - Elsewhere: plain copy fallback (slow but correct).
//
// Worktree location follows lane: `<gitRoot>/.lane/trees/<slug>`, branch `<slug>`.

import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export type LaneResult = {
  name: string
  branch: string
  directory: string
  gitRoot: string
  via: "lane" | "git+reflink" | "git+copy" | "git"
  reflink: boolean
  ignoredCloned: number
  ignoredBytes: number
}

export function slugify(input: string): string {
  // Allow '/' for git branch namespacing (feat/login). Each segment is slugified
  // independently so "Fix / Login!!" -> "fix/login". Empty segments are dropped.
  const raw = input.trim().toLowerCase()
  if (!raw) throw new Error(`Invalid lane name "${input}". Use letters, numbers, dashes, slashes (e.g. "fix-login" or "feat/login").`)
  const segments = raw
    .split("/")
    .map((seg) =>
      seg
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, ""),
    )
    .filter(Boolean)
  const slug = segments.join("/").slice(0, 80)
  if (!slug) throw new Error(`Invalid lane name "${input}". Use letters, numbers, dashes, slashes (e.g. "fix-login" or "feat/login").`)
  return slug
}

export function validateLaneName(input: string): string {
  const slug = slugify(input)
  // Count alphanumeric chars, ignoring slashes and dashes.
  const alnum = slug.replace(/[^a-z0-9]/g, "")
  if (alnum.length < 2) throw new Error(`Lane name "${input}" is too short after slugify ("${slug}"). Use at least 2 chars.`)
  return slug
}

export function sessionTitleFor(slug: string): string {
  // Session titles are plain text, but keeping '/' is confusing in some UIs
  // (looks like a path). Use " — " for slashes so "feat/login" -> "feat — login"
  // keeps both parts readable while preserving the original lane name elsewhere.
  return slug.replace(/\//g, " — ")
}

function runGit(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string
    return { code: 0, stdout, stderr: "" }
  } catch (e: any) {
    return {
      code: typeof e?.status === "number" ? e.status : 1,
      stdout: typeof e?.stdout === "string" ? e.stdout : "",
      stderr: typeof e?.stderr === "string" ? e.stderr : String(e?.message || e),
    }
  }
}

export function gitRoot(cwd: string): string {
  const r = runGit(["rev-parse", "--show-toplevel"], cwd)
  if (r.code !== 0) throw new Error(`Not a git repository (cwd: ${cwd}). fork-lane requires git. ${r.stderr.slice(0, 200)}`)
  return r.stdout.trim()
}

export function branchExists(gitDir: string, branch: string): boolean {
  const r = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], gitDir)
  return r.code === 0
}

export function worktreePathFor(gitDir: string, name: string): string {
  return path.join(gitDir, ".lane", "trees", name)
}

function hasLaneBinary(): boolean {
  try {
    const r = spawnSync("lane", ["--version"], { stdio: "ignore", timeout: 5000 })
    return r.status === 0 || r.error === undefined && r.status !== 127
  } catch {
    return false
  }
}

function tryLaneNew(gitDir: string, name: string, base?: string): string | undefined {
  // lane new prints the new path on stdout (shellenv cd's into it).
  // Try --base when provided; fall back without it.
  const attempts: string[][] = base ? [["new", name, "--base", base], ["new", name]] : [["new", name]]
  for (const args of attempts) {
    try {
      const out = execFileSync("lane", args, { cwd: gitDir, encoding: "utf8", timeout: 120_000 }) as string
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
      // Last absolute path line is the lane dir.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (path.isAbsolute(line) && fs.existsSync(line)) return line
      }
      // lane may print path without trailing check — construct expected.
      const expected = worktreePathFor(gitDir, name)
      if (fs.existsSync(expected)) return expected
    } catch {
      // fall through to next attempt / manual path
    }
  }
  return undefined
}

/** All git-ignored paths (files + dirs) under gitRoot, lane-style. */
export function listIgnored(gitDir: string): string[] {
  // Prefer `ls-files --directory`: ignored dirs come as `node_modules/`
  // (one cp) instead of per-file (`node_modules/foo/index.js`).
  const r = runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], gitDir)
  if (r.code === 0 && r.stdout) {
    const out: string[] = []
    for (const raw of r.stdout.split("\0")) {
      const p = raw.trim()
      if (!p) continue
      // ls-files --directory appends `/` to dirs; strip for path.join.
      out.push(p.endsWith("/") ? p.slice(0, -1) : p)
    }
    if (out.length) return out
  }
  // Fallback: `git status --porcelain --ignored` lists ignored as `!! <path>`.
  const s = runGit(["status", "--porcelain", "--ignored", "--untracked-files=all"], gitDir)
  if (s.code !== 0) return []
  const out: string[] = []
  for (const line of s.stdout.split("\n")) {
    if (!line.startsWith("!!")) continue
    const p = line.slice(2).trim()
    if (!p) continue
    // status quotes paths with spaces; strip surrounding quotes.
    const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p
    out.push(unquoted)
  }
  return out
}

function dirSizeBytes(p: string): number {
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of fs.readdirSync(p)) {
      try {
        total += dirSizeBytes(path.join(p, entry))
      } catch {}
    }
    return total
  } catch {
    return 0
  }
}

function reflinkCopy(src: string, dst: string): { ok: boolean; reflink: boolean } {
  // Returns { ok, reflink } — reflink true when clonefile/reflink succeeded.
  const parent = path.dirname(dst)
  try {
    fs.mkdirSync(parent, { recursive: true })
  } catch {}
  if (fs.existsSync(dst)) return { ok: true, reflink: false }
  // macOS APFS clonefile
  if (process.platform === "darwin") {
    const r = spawnSync("cp", ["-cR", src, dst], { stdio: "ignore", timeout: 120_000 })
    if (r.status === 0 && fs.existsSync(dst)) return { ok: true, reflink: true }
    // fallback plain copy
    const f = spawnSync("cp", ["-R", src, dst], { stdio: "ignore", timeout: 300_000 })
    return { ok: f.status === 0 && fs.existsSync(dst), reflink: false }
  }
  // Linux: reflink=always, fallback to plain copy
  const r = spawnSync("cp", ["--reflink=always", "-a", src, dst], { stdio: "ignore", timeout: 300_000 })
  if (r.status === 0 && fs.existsSync(dst)) return { ok: true, reflink: true }
  const f = spawnSync("cp", ["-a", src, dst], { stdio: "ignore", timeout: 300_000 })
  return { ok: f.status === 0 && fs.existsSync(dst), reflink: false }
}

export function cloneIgnored(opts: { gitRoot: string; targetDir: string }): { count: number; bytes: number; reflink: boolean } {
  const ignored = listIgnored(opts.gitRoot)
  let count = 0
  let bytes = 0
  let anyReflink = false
  let anyCopy = false
  for (const rel of ignored) {
    // Skip .lane itself (would recurse) and .git
    if (rel === ".lane" || rel.startsWith(".lane/") || rel === ".git" || rel.startsWith(".git/")) continue
    const src = path.join(opts.gitRoot, rel)
    const dst = path.join(opts.targetDir, rel)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dst)) continue
    const size = dirSizeBytes(src)
    const { ok, reflink } = reflinkCopy(src, dst)
    if (ok) {
      count++
      bytes += size
      if (reflink) anyReflink = true
      else anyCopy = true
    }
  }
  return { count, bytes, reflink: anyReflink && !anyCopy ? true : anyReflink }
}

export function createLaneWorktree(opts: {
  cwd: string
  name: string
  base?: string
}): LaneResult {
  const slug = validateLaneName(opts.name)
  const root = gitRoot(opts.cwd)
  const branch = slug
  const target = worktreePathFor(root, slug)

  if (fs.existsSync(target)) {
    throw new Error(`Lane "${slug}" already exists at ${target}. Pick another name or remove it (git worktree remove --force ${target}).`)
  }

  // Prefer the real lane binary when installed — full fidelity (reflink + memory).
  if (hasLaneBinary()) {
    const laneDir = tryLaneNew(root, slug, opts.base)
    if (laneDir && fs.existsSync(laneDir)) {
      return {
        name: slug,
        branch,
        directory: laneDir,
        gitRoot: root,
        via: "lane",
        reflink: true,
        ignoredCloned: -1,
        ignoredBytes: -1,
      }
    }
    // lane binary present but `lane new` failed — fall through to manual.
  }

  // Manual lane-like path.
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const exists = branchExists(root, branch)
  // Mirror opencode worktree: --no-checkout then reset --hard to populate.
  const addArgs = exists
    ? ["worktree", "add", "--no-checkout", target, branch]
    : ["worktree", "add", "--no-checkout", "-b", branch, target]
  // When --base is given and branch is new, branch from base explicitly:
  // `git worktree add -b <branch> <target> <base>`
  const addArgsWithBase = !exists && opts.base
    ? ["worktree", "add", "--no-checkout", "-b", branch, target, opts.base]
    : addArgs
  const added = runGit(addArgsWithBase, root)
  if (added.code !== 0) {
    throw new Error(`git worktree add failed: ${(added.stderr || added.stdout).slice(0, 500)}`)
  }
  const populated = runGit(["reset", "--hard"], target)
  if (populated.code !== 0) {
    // Clean up half-created worktree to avoid litter.
    try {
      runGit(["worktree", "remove", "--force", target], root)
    } catch {}
    throw new Error(`git reset --hard failed in ${target}: ${(populated.stderr || populated.stdout).slice(0, 500)}`)
  }

  const { count, bytes, reflink } = cloneIgnored({ gitRoot: root, targetDir: target })
  return {
    name: slug,
    branch,
    directory: target,
    gitRoot: root,
    via: count === 0 ? "git" : reflink ? "git+reflink" : "git+copy",
    reflink,
    ignoredCloned: count,
    ignoredBytes: bytes,
  }
}

export function formatBytes(n: number): string {
  if (n < 0) return "n/a"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}
