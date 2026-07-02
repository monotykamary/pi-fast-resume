import { openSync, readSync, closeSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
  // Internal forward-pass bookkeeping for the deferred rename-name resolver.
  // Not part of the public contract; only loadSessionHeaderForward sets these.
  /** @internal forward pass consumed the whole file — forward name is final; the deferred tail resolver skips it. */
  _fwdReachedEof?: boolean;
  /** @internal bytes the forward pass consumed — lower bound for the deferred tail read so it never re-reads covered bytes. */
  _fwdConsumedBytes?: number;
  // Internal lazy cache for the search blob (id + name + firstMessage + cwd).
  // Built on first matchSession call, invalidated when `name` mutates (rename
  // resolution). Keeps per-keystroke search from re-concatenating per session.
  /** @internal */
  _searchText?: string;
}

export interface SessionFileMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

// I/O granularity for the streaming forward reader. This is pure performance
// tuning — it does NOT affect correctness. The reader assembles complete lines
// across chunks (a line is never truncated mid-JSON), so a line of any size is
// parsed correctly regardless of this value. It only controls how many bytes
// each readSync call fetches; smaller = more syscalls for big reads, larger =
// over-read for tiny sessions that stop early. 16KB is a reasonable middle.
const READ_CHUNK_SIZE = 16_384;

// Tail read for recovering the latest session_info (the rename name) near EOF.
//
// Why a tail read exists at all: pi appends session_info as a new line on every
// /rename (appendSessionInfo → appendFileSync). The forward pass stops at the
// first user message, which can be very early in a large file — so the latest
// rename often lives past the forward pass's stop point and must be recovered
// from the end of the file.
//
// Why the bound is this size and not "scan to EOF": scanning the whole file
// backward to find a session_info that may not exist (98% of sessions are never
// renamed) collapses pi-fast-resume's perf to pi-core's (~100× slower). So the
// tail is bounded. The bound only needs to cover "the rename line itself plus
// any continued activity written after the rename before reopening."
//
// Measurement (across 47 real renamed sessions on this system): the latest
// session_info was at EOF in 100% of cases — the rename was the last write
// before the session was reopened, every single time. 32KB therefore covers all
// observed renames with ~32,000× margin, and also covers a rename followed by
// up to ~32KB of continued activity (dozens of typical message turns) before
// reopening. A rename followed by more than this much continued activity is
// missed and falls back to firstMessage — the documented tradeoff vs a
// full-file scan.
const TAIL_READ_SIZE = 32_768;

// Defensive guard against a single pathological line with no newline (e.g. a
// corrupted file). Real pi sessions are newline-terminated JSONL, so this never
// triggers on valid input. It only caps memory for malformed input.
const MAX_LINE_BYTES = 256 * 1024 * 1024;

// Result of scanning a file tail for session_info entries.
//   found: false  → no session_info seen in the tail; fall back to the forward name.
//   found: true   → a session_info was seen (later in file order than anything
//                   the forward pass saw, since the tail starts past the forward
//                   stop); name is undefined if that entry explicitly cleared it.
export interface TailSessionInfo {
  found: boolean;
  name?: string;
}

// Accumulator state while processing complete session entries line by line.
// Shared by the pure parseSessionFromBuffer and the streaming loadSessionHeader
// so the per-entry logic exists in exactly one place.
interface SessionAccumulator {
  header: { id: string; timestamp: string; cwd?: string; parentSession?: string } | null;
  firstUserMessage: string;
  messageCount: number;
  name: string | undefined;
  lastActivityTime: number | undefined;
  foundFirstUser: boolean;
}

function newAccumulator(): SessionAccumulator {
  return {
    header: null,
    firstUserMessage: "",
    messageCount: 0,
    name: undefined,
    lastActivityTime: undefined,
    foundFirstUser: false,
  };
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

// Process one complete entry line. Pure: mutates only `acc`. Malformed JSON (a
// line truncated at a read boundary, or genuinely corrupt input) is swallowed
// by the try/catch — callers only ever feed complete lines, so a parse failure
// here means the line is malformed and skipping it is correct.
function processEntry(acc: SessionAccumulator, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let entry: any;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof entry !== "object" || entry === null) return;

  if (entry.type === "session") {
    acc.header = entry;
    return;
  }
  if (entry.type === "session_info") {
    // Latest session_info in file order wins, including explicit clears
    // (empty/whitespace name → undefined). Matches pi-core's getSessionName().
    acc.name = entry.name?.trim() || undefined;
    return;
  }
  if (entry.type === "message") {
    acc.messageCount++;

    // Track last activity time. Matches pi-core's getMessageActivityTime
    // priority: message.timestamp (number) > entry.timestamp (date string).
    const msg = entry.message;
    if (msg?.role === "user" || msg?.role === "assistant") {
      const msgTimestamp = msg.timestamp;
      if (typeof msgTimestamp === "number" && msgTimestamp > 0) {
        acc.lastActivityTime = Math.max(acc.lastActivityTime ?? 0, msgTimestamp);
      } else if (typeof entry.timestamp === "string") {
        const t = Date.parse(entry.timestamp);
        if (!Number.isNaN(t)) {
          acc.lastActivityTime = Math.max(acc.lastActivityTime ?? 0, t);
        }
      }
    }

    if (!acc.foundFirstUser && msg?.role === "user") {
      acc.firstUserMessage = extractTextFromContent(msg.content);
      acc.foundFirstUser = true;
    }
  }
}

// Build the SessionHeader from an accumulator. `reachedEof` is whether the
// forward pass consumed all input — when false (it stopped early at the first
// user message), lastActivityTime only reflects entries seen and is unreliable,
// so stat mtime is used instead (pi updates it on every append, so it tracks
// the true last write time). `tailInfo`, if present, carries the latest
// session_info from a tail read and wins over the forward name (later in file
// order), including explicit name clears.
function buildHeader(
  acc: SessionAccumulator,
  filePath: string,
  mtimeMs: number,
  reachedEof: boolean,
  tailInfo?: TailSessionInfo,
): SessionHeader | null {
  const header = acc.header;
  if (!header) return null;

  const name = tailInfo?.found ? tailInfo.name : acc.name;

  const headerTime = Date.parse(header.timestamp);
  let modified: Date;
  if (!reachedEof) {
    // Partial read — stat mtime is the only reliable signal.
    modified = new Date(mtimeMs);
  } else if (typeof acc.lastActivityTime === "number" && acc.lastActivityTime > 0) {
    modified = new Date(acc.lastActivityTime);
  } else if (!Number.isNaN(headerTime)) {
    modified = new Date(headerTime);
  } else {
    modified = new Date(mtimeMs);
  }

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    parentSessionPath: header.parentSession || undefined,
    created: new Date(header.timestamp),
    modified,
    messageCount: acc.messageCount,
    firstMessage: acc.firstUserMessage || "(no messages)",
    name,
  };
}

// Pure parser over a buffer containing complete (or complete-prefix) entry
// lines. Splits on \n and runs processEntry on each line; the last line may be
// truncated at the buffer boundary (its JSON.parse fails and it is skipped).
// `partial` means the buffer does not contain the whole file — when true,
// modified time falls back to stat mtime (the buffer's lastActivityTime only
// reflects the prefix). `tailInfo` carries a tail-read latest session_info that
// overrides the buffer's name.
//
// Kept as a pure, synchronous, fd-free function for direct testing and
// callers that already have the bytes. loadSessionHeader (the production path)
// uses the streaming reader below so it never truncates a line mid-JSON.
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
  const acc = newAccumulator();
  for (const line of lines) processEntry(acc, line);
  return buildHeader(acc, filePath, mtimeMs, !partial, tailInfo);
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
    // #7 — Cheap pre-filter: only session_info entries matter here, so skip
    // JSON.parse for the (common) message lines without a full parse. The
    // quoted marker is conservative — a message whose content literally
    // contains "session_info" false-positives into one parse (harmless); a
    // real session_info entry always carries it. Partial lines at the
    // read-start boundary lack the marker and skip cheaply (JSON.parse would
    // have thrown and been caught anyway).
    if (!trimmed.includes('"session_info"')) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry === "object" && entry !== null && entry.type === "session_info") {
        found = true;
        name = entry.name?.trim() || undefined;
      }
    } catch {
      // Partial line at tail boundary — skip
    }
  }
  return { found, name };
}

// Read complete lines forward from `fd` starting at offset 0. Calls onLine for
// each complete (newline-terminated) line. Reading stops when onLine returns
// false, or at EOF. Returns whether EOF was reached (i.e. the caller did not
// stop early) and the byte offset just past the last emitted line's newline —
// the caller uses this as the lower bound for any tail scan so the tail never
// re-reads already-covered bytes.
//
// Chunk-based I/O with a StringDecoder so multi-byte UTF-8 sequences split
// across chunk boundaries decode correctly. The in-memory line buffer grows to
// fit the longest single line (bounded by MAX_LINE_BYTES against malformed
// input); real entries are newline-terminated so this is unbounded only for
// corrupt files.
function forEachLineForward(
  fd: number,
  size: number,
  onLine: (line: string) => boolean | void,
): { reachedEof: boolean; consumedBytes: number } {
  const decoder = new StringDecoder("utf8");
  // #8 — allocUnsafe: readSync fully overwrites [0, bytesRead) before the
  // buffer is read (via decoder.write(subarray(0, bytesRead))), so the
  // zero-fill of Buffer.alloc is wasted work. Skips a 16 KB memset per file.
  const chunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
  let lineBuf = "";
  let offset = 0;
  let consumedBytes = 0;

  const flushLine = (line: string): boolean | void => {
    consumedBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for \n
    return onLine(line);
  };

  while (offset < size) {
    const toRead = Math.min(READ_CHUNK_SIZE, size - offset);
    const bytesRead = readSync(fd, chunk, 0, toRead, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;

    const text = decoder.write(chunk.subarray(0, bytesRead));
    let start = 0;
    let nl: number;
    while ((nl = text.indexOf("\n", start)) !== -1) {
      const line = lineBuf + text.slice(start, nl);
      lineBuf = "";
      if (flushLine(line) === false) {
        return { reachedEof: false, consumedBytes };
      }
      start = nl + 1;
    }
    lineBuf += text.slice(start);

    // Defensive: bound memory for a single pathological line.
    if (lineBuf.length > MAX_LINE_BYTES) {
      lineBuf = "";
    }
  }
  // Flush decoder + any trailing line without a final newline.
  const tail = decoder.end();
  if (tail) lineBuf += tail;
  if (lineBuf.length > 0) {
    consumedBytes += Buffer.byteLength(lineBuf, "utf8"); // no trailing \n
    onLine(lineBuf);
  }
  return { reachedEof: true, consumedBytes };
}

const DEFAULT_SESSIONS_DIR = join(getAgentDir(), "sessions");

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

// Forward-only load: reads complete lines from the start and stops at the
// first user message (which is all the title row needs). This reads exactly as
// many bytes as the first user message requires — a few KB for a normal
// session, ~19KB for a <skill> injection, more for a base64 image — and never
// truncates a line mid-JSON the way a fixed byte window would. So oversized
// first user messages (the cases that used to show "(no messages)") are parsed
// correctly.
//
// No tail read — the returned header's name reflects only session_info entries
// seen within the forward window. For sessions whose latest rename lives past
// the forward stop point (the common case for renamed large sessions), pair
// this with resolveSessionName() run in the background; the name then populates
// in-place without blocking the picker's initial render.
export function loadSessionHeaderForward(
  meta: SessionFileMeta,
): SessionHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(meta.path, "r");
    const acc = newAccumulator();
    const { reachedEof, consumedBytes } = forEachLineForward(fd, meta.size, (line) => {
      processEntry(acc, line);
      if (acc.header && acc.foundFirstUser) return false;
      return true;
    });
    const header = buildHeader(acc, meta.path, meta.mtimeMs, reachedEof);
    if (header) {
      // Carry forward-pass bookkeeping so the deferred rename-name resolver can
      // skip files whose forward pass reached EOF (name already final) and bound
      // its tail read below by the consumed bytes (never re-reads covered bytes).
      header._fwdReachedEof = reachedEof;
      header._fwdConsumedBytes = consumedBytes;
    }
    return header;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Resolve the latest session_info (the rename name) from a bounded tail at EOF,
// independent of any forward pass. Returns found:false when no session_info
// lives in the tail region (keep whatever name the forward pass produced);
// found:true means a session_info was seen — its name (or explicit clear)
// overrides the forward name (it is later in file order).
//
// This is the deferred half of loadSessionHeader, exposed so callers can show
// a row immediately with the forward name and resolve the rename name in the
// background. Reading up to TAIL_READ_SIZE bytes from EOF may overlap the
// forward region for small files. Pass `consumedBytesLowerBound` (the forward
// pass's consumedBytes) so the tail starts at/after the bytes the forward pass
// already parsed — avoiding a redundant re-read and re-parse of that range.
// When the bound equals the file size (the forward pass reached EOF) there are
// no bytes left to read and this returns found:false; callers that already
// know the forward pass reached EOF should skip the call entirely (see
// resolveSessionNamesDeferred).
export function resolveSessionName(
  meta: SessionFileMeta,
  options?: { consumedBytesLowerBound?: number },
): TailSessionInfo {
  if (meta.size <= 0) return { found: false };
  // Bound the tail below by the forward pass's consumed bytes so it never
  // re-reads bytes the forward pass already covered. Matches the combined
  // loadSessionHeader path's tail math: tailReadSize = min(TAIL, size - bound),
  // tailOffset = size - tailReadSize (>= bound).
  const lowerBound = Math.max(0, Math.min(options?.consumedBytesLowerBound ?? 0, meta.size));
  const tailReadSize = Math.min(TAIL_READ_SIZE, meta.size - lowerBound);
  if (tailReadSize <= 0) return { found: false };
  let fd: number | undefined;
  try {
    fd = openSync(meta.path, "r");
    // #8 — allocUnsafe: readSync overwrites [0, bytesRead) before use.
    const tailBuf = Buffer.allocUnsafe(tailReadSize);
    const tailOffset = meta.size - tailReadSize;
    const tailBytesRead = readSync(fd, tailBuf, 0, tailReadSize, tailOffset);
    return scanTailForSessionInfo(tailBuf, tailBytesRead);
  } catch {
    return { found: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Resolve rename names for a batch of forward-loaded headers, the pure core of
// the picker's cooperative name-resolution drain. Skips headers whose forward
// pass reached EOF (their name is already final — no tail read needed) and
// bounds each remaining tail read below by the forward pass's consumed bytes
// (never re-reads already-covered bytes). Returns only paths whose tail found
// a session_info (name may be undefined for an explicit clear), for the caller
// to apply in-place. Exposed for direct testing and benchmarking.
export function resolveSessionNamesDeferred(
  headers: SessionHeader[],
  metaByPath: Map<string, SessionFileMeta>,
): Map<string, string | undefined> {
  const updates = new Map<string, string | undefined>();
  for (const h of headers) {
    if (h._fwdReachedEof) continue; // forward pass saw every session_info
    const meta = metaByPath.get(h.path);
    if (!meta) continue;
    const tail = resolveSessionName(meta, { consumedBytesLowerBound: h._fwdConsumedBytes });
    if (tail.found) updates.set(h.path, tail.name);
  }
  return updates;
}

// Load a session header using a streaming forward read plus a bounded tail read
// — forward + tail in one shared fd. Equivalent to loadSessionHeaderForward
// followed by resolveSessionName, but bounds the tail below by the forward stop
// offset so it never re-reads already-covered bytes. Use this when the full
// header (including rename name) is needed synchronously.
export function loadSessionHeader(
  meta: SessionFileMeta,
): SessionHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(meta.path, "r");
    const acc = newAccumulator();

    // Forward pass: read complete lines, stopping at the first user message.
    const { reachedEof: forwardReachedEof, consumedBytes } = forEachLineForward(
      fd,
      meta.size,
      (line) => {
        processEntry(acc, line);
        if (acc.header && acc.foundFirstUser) return false;
        return true;
      },
    );

    // If the forward pass stopped before EOF, recover the latest session_info
    // from a bounded tail at EOF. Bounded below by consumedBytes so it never
    // re-parses already-seen entries; the tail wins over the forward name
    // (later in file order). A failure here falls back to the forward name.
    let tailInfo: TailSessionInfo | undefined;
    if (!forwardReachedEof) {
      try {
        const tailReadSize = Math.min(TAIL_READ_SIZE, meta.size - consumedBytes);
        // #8 — allocUnsafe: readSync overwrites [0, bytesRead) before use.
        const tailBuf = Buffer.allocUnsafe(tailReadSize);
        const tailOffset = meta.size - tailReadSize;
        const tailBytesRead = readSync(fd, tailBuf, 0, tailReadSize, tailOffset);
        tailInfo = scanTailForSessionInfo(tailBuf, tailBytesRead);
      } catch {
        // Tail read failed — fall back to forward-only name
      }
    }

    return buildHeader(acc, meta.path, meta.mtimeMs, forwardReachedEof, tailInfo);
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

// Forward-only batch load — see loadSessionHeaderForward. Use for the picker's
// immediate display path: rows appear instantly with the correct firstMessage,
// and rename names resolve in the background via resolveSessionName().
export function loadSessionHeadersForward(
  metas: SessionFileMeta[],
): SessionHeader[] {
  const results: SessionHeader[] = [];
  for (const meta of metas) {
    const header = loadSessionHeaderForward(meta);
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

// Process-lifetime memo of realpath results. canonicalizePath is called
// 2–3× per session per tree build (buildSessionTree) and once per visible row
// per render (isCurrentSessionPath), and the tree is rebuilt on every keystroke
// in threaded mode. realpathSync is a syscall (~µs each); memoizing collapses
// thousands of syscalls per keystroke to Map lookups. This is pure memoization
// (no persistent file, no staleness to manage) — realpath of a path is stable
// for the process lifetime unless a symlink target changes, which doesn't
// happen to session files under ~/.pi/agent/sessions. Call
// clearCanonicalPathCache() to reset (used by tests/benches).
const canonicalPathCache = new Map<string, string>();

/**
 * Canonicalize a file path by resolving symlinks, memoized per process.
 * Matches pi-core's canonicalizePath behavior (realpathSync with fallback).
 */
export function canonicalizePath(path: string): string {
  const cached = canonicalPathCache.get(path);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    result = realpathSync(path);
  } catch {
    result = path;
  }
  canonicalPathCache.set(path, result);
  return result;
}

/** Clear the canonicalizePath memo. Intended for tests/benches. */
export function clearCanonicalPathCache(): void {
  canonicalPathCache.clear();
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