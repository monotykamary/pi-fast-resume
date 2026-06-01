import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
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
): SessionHeader | null {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buf.subarray(0, bytesRead)) + decoder.end();
  const lines = text.split("\n");

  let header: { id: string; timestamp: string; cwd?: string; parentSession?: string } | null = null;
  let firstUserMsg = "";
  let name = "";
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
        const n = entry.name?.trim();
        if (n) name = n;
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

  // Determine modified time using pi-core's priority:
  //   message timestamp > header timestamp > stat mtime
  // Note: partial reads may underestimate lastActivityTime for sessions
  // larger than PARTIAL_READ_SIZE, since only the first 16KB is read.
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  const modified =
    typeof lastActivityTime === "number" && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : !Number.isNaN(headerTime)
        ? new Date(headerTime)
        : new Date(mtimeMs);

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    parentSessionPath: header.parentSession || undefined,
    created: new Date(header.timestamp),
    modified,
    messageCount: msgCount,
    firstMessage: firstUserMsg || "",
    name: name || undefined,
  };
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
    return parseSessionFromBuffer(buf, bytesRead, meta.path, meta.mtimeMs);
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
