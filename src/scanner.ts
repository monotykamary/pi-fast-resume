import { openSync, readSync, closeSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export interface SessionHeader {
  path: string;
  id: string;
  cwd: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  name?: string;
}

export interface SessionFileMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

const PARTIAL_READ_SIZE = 16_384;

// Size of the trailing read used to recover session_info entries (session
// names set via /rename or programmatically). These are appended at EOF by
// SessionManager.appendSessionInfo, so for any session larger than the head
// window the latest name lands past the partial read and would be invisible —
// showing "(no messages)" for renamed large sessions. The tail read recovers
// it, matching pi-core's getSessionName() semantics (latest session_info wins,
// including explicit name clears).
const TAIL_READ_SIZE = 8_192;

// Result of scanning a file tail for session_info entries.
//   found: false  → no session_info seen in the tail; fall back to the head's name.
//   found: true   → a session_info was seen (later in file order than anything
//                   in the head, since the tail starts past the head window);
//                   name is undefined if that entry explicitly cleared the name.
export interface TailSessionInfo {
  found: boolean;
  name?: string;
}

function extractTextFromContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join(" ");
}

export function parseSessionFromBuffer(
  buf: Buffer,
  bytesRead: number,
  filePath: string,
  mtimeMs: number,
  partial = false,
  tailInfo?: TailSessionInfo,
): SessionHeader | null {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buf.subarray(0, bytesRead)) + decoder.end();
  const lines = text.split("\n");

  let header: { id: string; timestamp: string; cwd?: string; parentSession?: string } | null = null;
  let firstUserMsg = "";
  let name: string | undefined;
  let msgCount = 0;
  let lastActivityTime: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === "session") {
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        name = entry.name?.trim() || undefined;
      }
      if (entry.type === "message") {
        msgCount++;

        // Track last activity time from user/assistant messages
        // Matches pi-core's getMessageActivityTime priority:
        //   message.timestamp (number) > entry.timestamp (date string)
        const msg = entry.message;
        if (msg?.role === "user" || msg?.role === "assistant") {
          const msgTimestamp = msg.timestamp;
          if (typeof msgTimestamp === "number" && msgTimestamp > 0) {
            lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
          } else if (typeof entry.timestamp === "string") {
            const t = new Date(entry.timestamp).getTime();
            if (!Number.isNaN(t)) {
              lastActivityTime = Math.max(lastActivityTime ?? 0, t);
            }
          }
        }

        if (!firstUserMsg && msg?.role === "user") {
          try {
            firstUserMsg = extractTextFromContent(msg.content);
          } catch {
            // Malformed content, skip
          }
        }
      }
    } catch {
      // Incomplete/truncated JSON at buffer boundary, skip
    }
  }

  if (!header) return null;

  // Determine modified time:
  //   - Full read: use pi-core's priority (message timestamp > header timestamp > stat mtime).
  //     lastActivityTime is accurate since we saw every message.
  //   - Partial read: stat mtime is more reliable than a partial lastActivityTime,
  //     which only reflects messages in the first 16KB and may severely underestimate
  //     the true last activity for large sessions.
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  let modified: Date;
  if (partial) {
    // Partial read — stat mtime is the most reliable signal
    modified = new Date(mtimeMs);
  } else {
    // Full read — pi-core's priority chain
    modified =
      typeof lastActivityTime === "number" && lastActivityTime > 0
        ? new Date(lastActivityTime)
        : !Number.isNaN(headerTime)
          ? new Date(headerTime)
          : new Date(mtimeMs);
  }

  // The tail scan (if any) sees session_info entries at EOF, which are later
  // in file order than anything in the head window — so it wins over the
  // head-derived name, including explicit clears (empty name → undefined).
  const finalName = tailInfo?.found ? tailInfo.name : name;

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    parentSessionPath: header.parentSession || undefined,
    created: new Date(header.timestamp),
    modified,
    messageCount: msgCount,
    firstMessage: firstUserMsg || "(no messages)",
    name: finalName,
  };
}

// Scan a tail chunk (read from near EOF) for session_info entries and return
// the latest name, matching pi-core's getSessionName() semantics: the latest
// session_info in file order wins, including explicit clears (empty name).
// The tail's first line may be a partial line cut off at the read-start
// boundary — it is skipped naturally when JSON.parse fails.
export function scanTailForSessionInfo(
  buf: Buffer,
  bytesRead: number,
): TailSessionInfo {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buf.subarray(0, bytesRead)) + decoder.end();
  const lines = text.split("\n");
  let found = false;
  let name: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === "session_info") {
        found = true;
        name = entry.name?.trim() || undefined;
      }
    } catch {
      // Partial line at tail boundary — skip
    }
  }
  return { found, name };
}

const HOME = homedir();
const DEFAULT_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");

/**
 * Scan ALL session directories under the root (~/.pi/agent/sessions/).
 * Each subdirectory contains .jsonl files for a specific cwd.
 */
export function scanAllSessionDirs(
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): SessionFileMeta[] {
  const results: SessionFileMeta[] = [];
  let dirs: string[];

  try {
    dirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return results;
  }

  for (const dir of dirs) {
    const subDir = join(sessionsDir, dir);
    let files: string[];
    try {
      files = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(subDir, file);
      try {
        const stat = statSync(path);
        results.push({
          path,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // File disappeared between readdir and stat, skip
      }
    }
  }

  return results;
}

/**
 * Scan only the session directory that corresponds to a given cwd.
 * Matches pi's built-in SessionManager.list() behavior.
 */
export function scanSessionDir(
  sessionDir: string,
): SessionFileMeta[] {
  const results: SessionFileMeta[] = [];

  let files: string[];
  try {
    files = readdirSync(sessionDir);
  } catch {
    return results;
  }

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(sessionDir, file);
    try {
      const stat = statSync(path);
      results.push({
        path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // File disappeared
    }
  }

  return results;
}

export function loadSessionHeader(
  meta: SessionFileMeta,
): SessionHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(meta.path, "r");
    const readSize = Math.min(PARTIAL_READ_SIZE, meta.size);
    const buf = Buffer.alloc(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, 0);

    // Recover the latest session name from EOF. session_info entries are
    // appended at EOF by SessionManager.appendSessionInfo, so for any session
    // larger than the head window they live past the 16KB read and would be
    // invisible. The tail read covers `meta.size - PARTIAL_READ_SIZE` bytes
    // (capped at TAIL_READ_SIZE), starting past the head window so it never
    // overlaps. A failure here must not lose the whole header — fall back to
    // head-only parsing by leaving tailInfo undefined.
    let tailInfo: TailSessionInfo | undefined;
    if (meta.size > PARTIAL_READ_SIZE) {
      try {
        const tailReadSize = Math.min(TAIL_READ_SIZE, meta.size - PARTIAL_READ_SIZE);
        const tailBuf = Buffer.alloc(tailReadSize);
        const tailOffset = meta.size - tailReadSize;
        const tailBytesRead = readSync(fd, tailBuf, 0, tailReadSize, tailOffset);
        tailInfo = scanTailForSessionInfo(tailBuf, tailBytesRead);
      } catch {
        // Tail read failed — fall back to head-only parse
      }
    }

    return parseSessionFromBuffer(
      buf,
      bytesRead,
      meta.path,
      meta.mtimeMs,
      meta.size > PARTIAL_READ_SIZE,
      tailInfo,
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function loadSessionHeaders(
  metas: SessionFileMeta[],
): SessionHeader[] {
  const results: SessionHeader[] = [];
  for (const meta of metas) {
    const header = loadSessionHeader(meta);
    if (header) results.push(header);
  }
  return results;
}

export function sortByModified(sessions: SessionHeader[]): SessionHeader[] {
  return sessions.sort(
    (a, b) => b.modified.getTime() - a.modified.getTime(),
  );
}

export function sortByModifiedDesc(metas: SessionFileMeta[]): SessionFileMeta[] {
  return metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Filter sessions by cwd, matching pi's sessionCwdMatches behavior:
 * resolves both paths before comparing so symlinks don't cause mismatches.
 */
export function filterByCwd(
  sessions: SessionHeader[],
  cwd: string,
): SessionHeader[] {
  const resolvedCwd = resolve(cwd);
  return sessions.filter((s) => {
    if (!s.cwd) return false;
    return resolve(s.cwd) === resolvedCwd;
  });
}

/**
 * Canonicalize a file path by resolving symlinks.
 * Matches pi-core's canonicalizePath behavior (realpathSync with fallback).
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function matchQuery(
  session: SessionHeader,
  query: string,
): boolean {
  const q = query.toLowerCase();
  if (session.firstMessage.toLowerCase().includes(q)) return true;
  if (session.name?.toLowerCase().includes(q)) return true;
  if (session.cwd.toLowerCase().includes(q)) return true;
  if (session.id.toLowerCase().includes(q)) return true;
  return false;
}
