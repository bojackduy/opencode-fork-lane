// ─── fork-lane: move-session helpers (pure, testable) ────────────────────────
// Used by the server plugin (raw POST to the experimental route) and the TUI
// plugin (error classification for toasts). Bun + Node compatible: no imports.
//
// Background: the v1 server-plugin SDK client has no controlPlane namespace,
// so the server tool moves via raw POST to
// `{serverUrl}/experimental/control-plane/move-session` with body
// `{ sessionID, destination: { directory }, moveChanges }` (exactly what the
// v2 SDK client sends — no query params). Two things kept biting us:
//
//  1. `serverUrl` can carry an unconnectable host (wildcard bind like
//     0.0.0.0, or `localhost` resolving to ::1 first). Every server-tool move
//     failed with "Unable to connect" while the TUI path (in-process client)
//     worked. So we try loopback-swapped candidate bases.
//  2. Failures were truncated to 160–300 chars and unclassified, so users saw
//     "can't move, don't know why". The server only ever returns a handful of
//     messages (verified against the opencode 1.18 binary), mapped below to a
//     kind + remedy.

export type MoveKind =
  | "project-mismatch"
  | "apply-conflict"
  | "not-found"
  | "not-git"
  | "unreachable"
  | "http"
  | "unknown"

export type MoveClassification = { kind: MoveKind; remedy: string }

const REMEDIES: Record<MoveKind, string> = {
  "project-mismatch":
    "Destination is outside the session's project. Open opencode in the lane directory and continue there, or TUI → Move session → lane directory.",
  "apply-conflict":
    "Uncommitted changes didn't apply cleanly. Retry lane with moveChanges=false, then move the changes over manually (git stash / git diff).",
  "not-found": "Session ID unknown to the server (stale fork?). Retry fork_lane.",
  "not-git": "Source or destination is not a git repository. fork-lane requires git on both ends.",
  unreachable:
    "Could not reach the opencode server. If this persists, move via TUI (/fork-lane moves correctly) or TUI → Move session → lane directory.",
  http: "Server rejected the move. See detail; or move via TUI → Move session → lane directory.",
  unknown: "Move via TUI → Move session → lane directory, or continue with absolute paths under the lane directory.",
}

export function classifyMoveError(message: string): MoveClassification {
  const m = message ?? ""
  let kind: MoveKind = "unknown"
  if (/belongs to another project/i.test(m)) kind = "project-mismatch"
  else if (/Unable to apply your changes/i.test(m)) kind = "apply-conflict"
  else if (/Session not found/i.test(m)) kind = "not-found"
  else if (/not a Git repository/i.test(m)) kind = "not-git"
  else if (/Unable to connect|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|Failed to fetch|network/i.test(m))
    kind = "unreachable"
  else if (/^moveSession HTTP \d+/i.test(m) || /^HTTP \d+/i.test(m)) kind = "http"
  return { kind, remedy: REMEDIES[kind]! }
}

/** Full move endpoint for a base (no trailing slash). Matches the v2 SDK: body-only, no query. */
export function moveEndpoint(base: string): string {
  return `${base.replace(/\/$/, "")}/experimental/control-plane/move-session`
}

/**
 * Candidate server bases to try, first wins. `serverUrl` may be unconnectable
 * as given (wildcard bind 0.0.0.0/::, or `localhost` hitting ::1 first), so we
 * also offer loopback-swapped variants. Returns unique bases, original first.
 */
export function candidateBases(serverUrl: string | URL): string[] {
  const raw = String(serverUrl ?? "").replace(/\/$/, "")
  if (!raw) return []
  const out: string[] = []
  const push = (b: string) => {
    if (b && !out.includes(b)) out.push(b)
  }
  push(raw)
  try {
    const u = new URL(raw)
    const host = u.hostname
    if (host === "0.0.0.0" || host === "::" || host === "[::]") {
      u.hostname = "127.0.0.1"
      push(u.toString().replace(/\/$/, ""))
    } else if (host === "localhost") {
      u.hostname = "127.0.0.1"
      push(u.toString().replace(/\/$/, ""))
    } else if (host === "127.0.0.1" || host === "::1") {
      u.hostname = "localhost"
      push(u.toString().replace(/\/$/, ""))
    }
  } catch {
    // Not a parseable URL — return raw only; fetch will report the real error.
  }
  return out
}

/** Short host:port label for diagnostics (no path, no secrets). */
export function hostPort(base: string): string {
  try {
    const u = new URL(base)
    return u.host || base
  } catch {
    return base
  }
}
