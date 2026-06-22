import { describe, it, expect } from "vitest";
import {
  parseSessionFromBuffer,
  sortByModified,
  filterByCwd,
  matchQuery,
  canonicalizePath,
  scanAllSessionDirs,
  scanSessionDir,
  scanTailForSessionInfo,
  loadSessionHeader,
  loadSessionHeaders,
  loadSessionHeaderForward,
  loadSessionHeadersForward,
  resolveSessionName,
  type SessionHeader,
  type TailSessionInfo,
} from "../src/scanner.js";
import {
  parseSearchQuery,
  matchSession,
  hasSessionName,
  filterAndSortSessions,
  buildSessionTree,
  flattenSessionTree,
  buildTreePrefix,
  type FlatSessionNode,
  type SortMode,
} from "../src/search.js";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeSession(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    path: "/test/session.jsonl",
    id: "test-id-1234",
    cwd: "/Users/test/project",
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date("2026-01-02T00:00:00Z"),
    messageCount: 5,
    firstMessage: "Hello world",
    ...overrides,
  };
}

describe("parseSessionFromBuffer", () => {
  it("parses a valid session header", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "abc-123", timestamp: "2026-01-15T10:00:00Z", cwd: "/home/user/proj" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "First message" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Response" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/session.jsonl", 1705312800000);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc-123");
    expect(result!.cwd).toBe("/home/user/proj");
    expect(result!.messageCount).toBe(2);
    expect(result!.firstMessage).toBe("First message");
  });

  it("extracts session name from session_info entry", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "abc-123", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "My Session" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Session");
  });

  it("extracts first user message from string content", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "thinking..." } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello there" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result!.firstMessage).toBe("Hello there");
  });

  it("handles truncated JSON at buffer boundary gracefully", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "abc", timestamp: "2026-01-15T10:00:00Z" }),
      '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"This will be trun',
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc");
  });

  it("returns null if no session header found", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).toBeNull();
  });

  it("counts only message entries", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "a" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "b" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "c" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result!.messageCount).toBe(3);
  });

  it("prefers message timestamp over stat mtime for modified time", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1705321200000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = 1704716400000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(1705321200000);
  });

  it("prefers message timestamp over header timestamp", () => {
    const headerTime = "2026-01-15T10:00:00Z";
    const msgTimestamp = new Date("2026-01-20T15:30:00Z").getTime();
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: headerTime }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: msgTimestamp } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(msgTimestamp);
  });

  it("falls back to header timestamp when no message timestamps are present", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = new Date("2026-06-01T00:00:00Z").getTime();
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(new Date("2026-01-15T10:00:00Z").getTime());
  });

  it("falls back to stat mtime when header timestamp is invalid", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "not-a-date" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = 1705312800000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(statMtime);
  });

  it("takes the latest message timestamp across multiple messages", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "first", timestamp: 1000 } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "second", timestamp: 3000 } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "third", timestamp: 2000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(3000);
  });

  it("uses entry timestamp as fallback when message.timestamp is absent", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-01-20T15:30:00Z", message: { role: "user", content: "hi" } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    const expectedTime = new Date("2026-01-20T15:30:00Z").getTime();
    expect(result!.modified.getTime()).toBe(expectedTime);
  });

  it("uses stat mtime for modified time on partial reads", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1705321200000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = 1705400000000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime, true);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(statMtime);
  });

  it("uses stat mtime on partial reads even when message timestamps are older", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "early msg", timestamp: 1000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = 1705400000000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime, true);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(statMtime);
  });

  it("full read still uses message timestamp over stat mtime", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1705321200000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const statMtime = 1704716400000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime);

    expect(result).not.toBeNull();
    expect(result!.modified.getTime()).toBe(1705321200000);
  });

  it("correctly decodes complete multi-byte characters within the buffer", () => {
    const name = "日本語テスト";
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.name).toBe(name);
  });

  it("handles multi-byte content in first user message", () => {
    const msg = "Bug in origöre❤️🔥";
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: msg }] } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.firstMessage).toBe(msg);
  });

  it("gracefully handles a multi-byte character split at the buffer boundary", () => {
    const name = "日本語テスト";
    const sessionLine = JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" });
    const infoLine = JSON.stringify({ type: "session_info", name });
    const full = sessionLine + "\n" + infoLine + "\n";
    const fullBuf = Buffer.from(full);

    const truncatedBytes = fullBuf.length - 3;
    const result = parseSessionFromBuffer(fullBuf, truncatedBytes, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("x");
  });

  it("extracts parentSessionPath from session header", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "child-1", timestamp: "2026-01-15T10:00:00Z", parentSession: "/parent/session.jsonl" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/child/session.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.parentSessionPath).toBe("/parent/session.jsonl");
  });

  it("returns undefined parentSessionPath when not present", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "orphan", timestamp: "2026-01-15T10:00:00Z" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.parentSessionPath).toBeUndefined();
  });
});

describe("scanAllSessionDirs / scanSessionDir", () => {
  const testDir = join(tmpdir(), "pi-fast-resume-test-" + process.pid);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("scanAllSessionDirs finds sessions across multiple subdirectories", () => {
    mkdirSync(join(testDir, "sub1"), { recursive: true });
    mkdirSync(join(testDir, "sub2"), { recursive: true });
    writeFileSync(join(testDir, "sub1", "a.jsonl"), '{"type":"session","id":"1","timestamp":"2026-01-01T00:00:00Z"}\n');
    writeFileSync(join(testDir, "sub2", "b.jsonl"), '{"type":"session","id":"2","timestamp":"2026-01-02T00:00:00Z"}\n');

    const metas = scanAllSessionDirs(testDir);
    expect(metas).toHaveLength(2);
  });

  it("scanAllSessionDirs returns empty for nonexistent dir", () => {
    const metas = scanAllSessionDirs(join(testDir, "nonexistent"));
    expect(metas).toHaveLength(0);
  });

  it("scanSessionDir finds sessions in a single directory", () => {
    mkdirSync(join(testDir, "single"), { recursive: true });
    writeFileSync(join(testDir, "single", "x.jsonl"), '{"type":"session","id":"1","timestamp":"2026-01-01T00:00:00Z"}\n');
    writeFileSync(join(testDir, "single", "y.jsonl"), '{"type":"session","id":"2","timestamp":"2026-01-02T00:00:00Z"}\n');
    writeFileSync(join(testDir, "single", "z.txt"), "not a session\n");

    const metas = scanSessionDir(join(testDir, "single"));
    expect(metas).toHaveLength(2);
  });

  it("scanSessionDir ignores non-jsonl files", () => {
    mkdirSync(join(testDir, "mixed"), { recursive: true });
    writeFileSync(join(testDir, "mixed", "readme.md"), "hello");
    writeFileSync(join(testDir, "mixed", "data.jsonl"), '{"type":"session","id":"1","timestamp":"2026-01-01T00:00:00Z"}\n');

    const metas = scanSessionDir(join(testDir, "mixed"));
    expect(metas).toHaveLength(1);
    expect(metas[0]!.path).toContain("data.jsonl");
  });
});

describe("sortByModified", () => {
  it("sorts sessions by modified date descending", () => {
    const sessions = [
      makeSession({ modified: new Date("2026-01-01") }),
      makeSession({ modified: new Date("2026-01-03") }),
      makeSession({ modified: new Date("2026-01-02") }),
    ];

    const sorted = sortByModified(sessions);
    expect(sorted[0]!.modified.getDate()).toBe(3);
    expect(sorted[2]!.modified.getDate()).toBe(1);
  });
});

describe("filterByCwd", () => {
  it("filters sessions by cwd with path resolution", () => {
    const sessions = [
      makeSession({ path: "/a", cwd: "/project/a" }),
      makeSession({ path: "/b", cwd: "/project/b" }),
      makeSession({ path: "/c", cwd: "/project/a" }),
    ];

    const filtered = filterByCwd(sessions, "/project/a");
    expect(filtered).toHaveLength(2);
  });

  it("resolves symlinks before comparing", () => {
    const sessions = [
      makeSession({ cwd: "/Users/test/project" }),
    ];

    expect(filterByCwd(sessions, "/Users/test/project")).toHaveLength(1);
  });

  it("excludes sessions with empty cwd", () => {
    const sessions = [
      makeSession({ cwd: "" }),
      makeSession({ cwd: "/project/a" }),
    ];

    const filtered = filterByCwd(sessions, "/project/a");
    expect(filtered).toHaveLength(1);
  });
});

describe("matchQuery", () => {
  it("matches against first message", () => {
    const session = makeSession({ firstMessage: "Fix the bug in auth" });
    expect(matchQuery(session, "bug")).toBe(true);
    expect(matchQuery(session, "BUG")).toBe(true);
    expect(matchQuery(session, "feature")).toBe(false);
  });

  it("matches against session name", () => {
    const session = makeSession({ name: "Auth refactor" });
    expect(matchQuery(session, "auth")).toBe(true);
  });

  it("matches against cwd", () => {
    const session = makeSession({ cwd: "/Users/me/projects/api" });
    expect(matchQuery(session, "api")).toBe(true);
  });

  it("matches against id", () => {
    const session = makeSession({ id: "abc-123-def" });
    expect(matchQuery(session, "abc-123")).toBe(true);
  });
});

describe("canonicalizePath", () => {
  it("canonicalizes an existing path", () => {
    const result = canonicalizePath(process.cwd());
    expect(result).toBe(process.cwd());
  });

  it("returns the path unchanged for nonexistent paths", () => {
    const nonexistent = "/this/path/does/not/exist/abc123";
    const result = canonicalizePath(nonexistent);
    expect(result).toBe(nonexistent);
  });
});

// Search module tests

describe("parseSearchQuery", () => {
  it("returns empty tokens for empty query", () => {
    const result = parseSearchQuery("");
    expect(result.mode).toBe("tokens");
    expect(result.tokens).toHaveLength(0);
  });

  it("parses fuzzy tokens separated by whitespace", () => {
    const result = parseSearchQuery("foo bar");
    expect(result.mode).toBe("tokens");
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).toEqual({ kind: "fuzzy", value: "foo" });
    expect(result.tokens[1]).toEqual({ kind: "fuzzy", value: "bar" });
  });

  it("parses regex mode with re: prefix", () => {
    const result = parseSearchQuery("re:auth.*bug");
    expect(result.mode).toBe("regex");
    expect(result.regex).not.toBeNull();
    expect(result.regex!.source).toBe("auth.*bug");
  });

  it("returns error for invalid regex", () => {
    const result = parseSearchQuery("re:([invalid");
    expect(result.mode).toBe("regex");
    expect(result.error).toBeTruthy();
    expect(result.regex).toBeNull();
  });

  it("returns error for empty regex", () => {
    const result = parseSearchQuery("re:");
    expect(result.error).toBe("Empty regex");
  });

  it("parses exact phrase in double quotes", () => {
    const result = parseSearchQuery('"node cve" bug');
    expect(result.mode).toBe("tokens");
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).toEqual({ kind: "phrase", value: "node cve" });
    expect(result.tokens[1]).toEqual({ kind: "fuzzy", value: "bug" });
  });

  it("handles unclosed quotes by falling back to fuzzy tokens", () => {
    const result = parseSearchQuery('"unclosed phrase');
    expect(result.mode).toBe("tokens");
    // Falls back to whitespace split — all fuzzy
    expect(result.tokens.every((t) => t.kind === "fuzzy")).toBe(true);
  });

  it("parses multiple quoted phrases", () => {
    const result = parseSearchQuery('"hello world" "foo bar"');
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).toEqual({ kind: "phrase", value: "hello world" });
    expect(result.tokens[1]).toEqual({ kind: "phrase", value: "foo bar" });
  });
});

describe("matchSession", () => {
  it("matches everything with empty tokens", () => {
    const session = makeSession();
    const parsed = parseSearchQuery("");
    expect(matchSession(session, parsed).matches).toBe(true);
  });

  it("fuzzy matches against session text", () => {
    const session = makeSession({ firstMessage: "Fix auth bypass", id: "abc-123" });
    const parsed = parseSearchQuery("auth");
    expect(matchSession(session, parsed).matches).toBe(true);
  });

  it("rejects non-matching fuzzy token", () => {
    const session = makeSession({ firstMessage: "Fix auth bypass" });
    const parsed = parseSearchQuery("xyz");
    expect(matchSession(session, parsed).matches).toBe(false);
  });

  it("all tokens must match", () => {
    const session = makeSession({ firstMessage: "Fix auth bypass in middleware", id: "abc" });
    const parsed = parseSearchQuery("auth bypass");
    expect(matchSession(session, parsed).matches).toBe(true);

    const parsed2 = parseSearchQuery("auth quantum");
    expect(matchSession(session, parsed2).matches).toBe(false);
  });

  it("matches regex queries", () => {
    const session = makeSession({ firstMessage: "Fix the auth bypass" });
    const parsed = parseSearchQuery("re:auth.*bypass");
    expect(matchSession(session, parsed).matches).toBe(true);
  });

  it("rejects non-matching regex", () => {
    const session = makeSession({ firstMessage: "Fix the auth bypass" });
    const parsed = parseSearchQuery("re:quantum");
    expect(matchSession(session, parsed).matches).toBe(false);
  });

  it("matches exact phrases", () => {
    const session = makeSession({ firstMessage: "Fix the node cve vulnerability" });
    const parsed = parseSearchQuery('"node cve"');
    expect(matchSession(session, parsed).matches).toBe(true);
  });

  it("rejects non-matching exact phrases", () => {
    const session = makeSession({ firstMessage: "Fix the auth bypass" });
    const parsed = parseSearchQuery('"node cve"');
    expect(matchSession(session, parsed).matches).toBe(false);
  });

  it("returns a score for ranking", () => {
    const session = makeSession({ firstMessage: "Fix auth bug" });
    const parsed = parseSearchQuery("auth");
    const result = matchSession(session, parsed);
    expect(result.matches).toBe(true);
    expect(typeof result.score).toBe("number");
  });
});

describe("hasSessionName", () => {
  it("returns true for named sessions", () => {
    expect(hasSessionName(makeSession({ name: "My Session" }))).toBe(true);
  });

  it("returns false for unnamed sessions", () => {
    expect(hasSessionName(makeSession())).toBe(false);
  });

  it("returns false for whitespace-only names", () => {
    expect(hasSessionName(makeSession({ name: "   " }))).toBe(false);
  });
});

describe("filterAndSortSessions", () => {
  const sessions = [
    makeSession({ id: "1", firstMessage: "Fix auth bypass", modified: new Date("2026-01-03") }),
    makeSession({ id: "2", firstMessage: "Add rate limiting", modified: new Date("2026-01-02") }),
    makeSession({ id: "3", firstMessage: "Refactor user service", modified: new Date("2026-01-01") }),
  ];

  it("returns all sessions with no query", () => {
    const result = filterAndSortSessions(sessions, "", "threaded");
    expect(result).toHaveLength(3);
  });

  it("filters by fuzzy query", () => {
    const result = filterAndSortSessions(sessions, "auth", "relevance");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("recent mode filters but keeps incoming order", () => {
    const result = filterAndSortSessions(sessions, "auth", "recent");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("relevance mode sorts by score then by modified desc", () => {
    const manySessions = [
      makeSession({ id: "1", firstMessage: "Fix auth bypass in middleware", modified: new Date("2026-01-01") }),
      makeSession({ id: "2", firstMessage: "Add rate limiting to API", modified: new Date("2026-01-02") }),
    ];

    const result = filterAndSortSessions(manySessions, "auth", "relevance");
    // Only session 1 matches "auth"
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("tie-breaks by modified desc when scores are equal", () => {
    const manySessions = [
      makeSession({ id: "1", firstMessage: "auth stuff", name: "auth", modified: new Date("2026-01-01") }),
      makeSession({ id: "2", firstMessage: "auth stuff", name: "auth", modified: new Date("2026-01-03") }),
    ];

    const result = filterAndSortSessions(manySessions, "auth", "relevance");
    expect(result).toHaveLength(2);
    // Same score, newer comes first
    expect(result[0]!.id).toBe("2");
  });

  it("applies name filter", () => {
    const named = [
      makeSession({ id: "1", firstMessage: "Fix bug", name: "Bug fix" }),
      makeSession({ id: "2", firstMessage: "Add feature" }),
    ];

    const result = filterAndSortSessions(named, "", "threaded", "named");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("returns empty for invalid regex", () => {
    const result = filterAndSortSessions(sessions, "re:([invalid", "relevance");
    expect(result).toHaveLength(0);
  });
});

describe("Session tree", () => {
  it("builds flat tree for sessions without parents", () => {
    const sessions = [
      makeSession({ path: "/a.jsonl", modified: new Date("2026-01-02") }),
      makeSession({ path: "/b.jsonl", modified: new Date("2026-01-03") }),
      makeSession({ path: "/c.jsonl", modified: new Date("2026-01-01") }),
    ];

    const roots = buildSessionTree(sessions);
    // All are roots since no parentSessionPath
    expect(roots).toHaveLength(3);
    // Sorted by modified desc
    expect(roots[0]!.session.path).toBe("/b.jsonl");
    expect(roots[1]!.session.path).toBe("/a.jsonl");
    expect(roots[2]!.session.path).toBe("/c.jsonl");
  });

  it("builds parent-child hierarchy", () => {
    const sessions = [
      makeSession({ path: "/parent.jsonl", id: "parent", modified: new Date("2026-01-01") }),
      makeSession({ path: "/child1.jsonl", id: "child1", parentSessionPath: "/parent.jsonl", modified: new Date("2026-01-02") }),
      makeSession({ path: "/child2.jsonl", id: "child2", parentSessionPath: "/parent.jsonl", modified: new Date("2026-01-03") }),
    ];

    const roots = buildSessionTree(sessions);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.path).toBe("/parent.jsonl");
    expect(roots[0]!.children).toHaveLength(2);
    // Children sorted by modified desc
    expect(roots[0]!.children[0]!.session.id).toBe("child2");
    expect(roots[0]!.children[1]!.session.id).toBe("child1");
  });

  it("handles orphan children (parent not in set)", () => {
    const sessions = [
      makeSession({ path: "/orphan.jsonl", id: "orphan", parentSessionPath: "/missing.jsonl", modified: new Date("2026-01-01") }),
    ];

    const roots = buildSessionTree(sessions);
    // Orphan becomes a root
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe("orphan");
  });

  it("supports deep nesting", () => {
    const sessions = [
      makeSession({ path: "/a.jsonl", id: "a", modified: new Date("2026-01-01") }),
      makeSession({ path: "/b.jsonl", id: "b", parentSessionPath: "/a.jsonl", modified: new Date("2026-01-02") }),
      makeSession({ path: "/c.jsonl", id: "c", parentSessionPath: "/b.jsonl", modified: new Date("2026-01-03") }),
    ];

    const roots = buildSessionTree(sessions);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe("a");
    expect(roots[0]!.children[0]!.session.id).toBe("b");
    expect(roots[0]!.children[0]!.children[0]!.session.id).toBe("c");
  });
});

describe("flattenSessionTree", () => {
  it("flattens a flat list of roots", () => {
    const sessions = [
      makeSession({ path: "/a.jsonl", id: "a", modified: new Date("2026-01-02") }),
      makeSession({ path: "/b.jsonl", id: "b", modified: new Date("2026-01-01") }),
    ];

    const roots = buildSessionTree(sessions);
    const flat = flattenSessionTree(roots);

    expect(flat).toHaveLength(2);
    expect(flat[0]!.session.id).toBe("a");
    expect(flat[0]!.depth).toBe(0);
    expect(flat[1]!.session.id).toBe("b");
    expect(flat[1]!.depth).toBe(0);
  });

  it("flattens a tree with children", () => {
    const sessions = [
      makeSession({ path: "/parent.jsonl", id: "parent", modified: new Date("2026-01-01") }),
      makeSession({ path: "/child1.jsonl", id: "child1", parentSessionPath: "/parent.jsonl", modified: new Date("2026-01-02") }),
      makeSession({ path: "/child2.jsonl", id: "child2", parentSessionPath: "/parent.jsonl", modified: new Date("2026-01-03") }),
    ];

    const roots = buildSessionTree(sessions);
    const flat = flattenSessionTree(roots);

    expect(flat).toHaveLength(3);
    expect(flat[0]!.session.id).toBe("parent");
    expect(flat[0]!.depth).toBe(0);
    expect(flat[1]!.session.id).toBe("child2");
    expect(flat[1]!.depth).toBe(1);
    expect(flat[2]!.session.id).toBe("child1");
    expect(flat[2]!.depth).toBe(1);

    // Verify tree prefixes match upstream behavior
    expect(buildTreePrefix(flat[0]!)).toBe(""); // depth 0 → no prefix
    // Children sorted by modified desc: child2 (Jan 3) first = not last, child1 (Jan 2) = last
    expect(buildTreePrefix(flat[1]!)).toBe("   ├─ "); // depth 1, not last child (child2)
    expect(buildTreePrefix(flat[2]!)).toBe("   └─ "); // depth 1, last child (child1)
  });

  it("tracks isLast correctly", () => {
    const sessions = [
      makeSession({ path: "/parent.jsonl", id: "parent", modified: new Date("2026-01-01") }),
      makeSession({ path: "/child.jsonl", id: "child", parentSessionPath: "/parent.jsonl", modified: new Date("2026-01-02") }),
    ];

    const roots = buildSessionTree(sessions);
    const flat = flattenSessionTree(roots);

    expect(flat[0]!.isLast).toBe(true); // parent is last root
    expect(flat[1]!.isLast).toBe(true); // child is last (only) child
  });
});

describe("buildTreePrefix", () => {
  it("returns empty string for depth 0", () => {
    const node: FlatSessionNode = {
      session: makeSession(),
      depth: 0,
      isLast: true,
      ancestorContinues: [],
    };
    expect(buildTreePrefix(node)).toBe("");
  });

  it("returns └─ for last child at depth 1", () => {
    const node: FlatSessionNode = {
      session: makeSession(),
      depth: 1,
      isLast: true,
      ancestorContinues: [false],
    };
    // ancestorContinues[0] = false → "   " (root parent doesn't continue)
    expect(buildTreePrefix(node)).toBe("   └─ ");
  });

  it("returns ├─ for non-last child at depth 1", () => {
    const node: FlatSessionNode = {
      session: makeSession(),
      depth: 1,
      isLast: false,
      ancestorContinues: [false],
    };
    expect(buildTreePrefix(node)).toBe("   ├─ ");
  });

  it("returns │  for continuing ancestor", () => {
    const node: FlatSessionNode = {
      session: makeSession(),
      depth: 2,
      isLast: true,
      ancestorContinues: [false, true],
    };
    // ancestorContinues[0] = false → "   " (root doesn't continue)
    // ancestorContinues[1] = true → "│  " (parent continues)
    expect(buildTreePrefix(node)).toBe("   │  └─ ");
  });

  it("renders deep nested structure correctly", () => {
    const node: FlatSessionNode = {
      session: makeSession(),
      depth: 3,
      isLast: false,
      ancestorContinues: [false, true, true],
    };
    expect(buildTreePrefix(node)).toBe("   │  │  ├─ ");
  });
});

describe("session_info name handling", () => {
  it("takes the latest non-empty session_info name", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "First" }),
      JSON.stringify({ type: "session_info", name: "Second" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Second");
  });

  it("clears the name when session_info name is empty", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Named" }),
      JSON.stringify({ type: "session_info", name: "   " }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.name).toBeUndefined();
  });
});

describe("firstMessage fallback", () => {
  it("defaults to (no messages) when there is no user message", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "thinking..." } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.firstMessage).toBe("(no messages)");
  });
});

describe("parseSessionFromBuffer tailInfo (session name from EOF)", () => {
  // tailInfo carries the latest session_info name found in a tail read of the
  // file (past the forward pass's stop point). It mirrors pi-core's
  // getSessionName(): later-in-file session_info wins over the forward name,
  // including explicit clears.

  it("uses tailInfo name when the forward pass saw no session_info", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "thinking..." } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0, false, {
      found: true,
      name: "Renamed at EOF",
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Renamed at EOF");
  });

  it("tailInfo wins over a stale forward-pass name (rename after the forward stop)", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Old name in head" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0, false, {
      found: true,
      name: "New name at EOF",
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("New name at EOF");
  });

  it("tailInfo explicit name clear wins over head's stale name", () => {
    // pi-core getSessionName() treats an empty/whitespace name as an explicit
    // clear; a tail-found clear must not fall back to the head's stale name.
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Old name in head" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0, false, {
      found: true,
      name: undefined,
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBeUndefined();
  });

  it("falls back to the head name when tail found no session_info", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Head name" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0, false, {
      found: false,
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Head name");
  });

  it("omitting tailInfo preserves the head-only behavior", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Head name" }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    // No tailInfo arg — exactly the old call signature
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", 0);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Head name");
  });
});

describe("scanTailForSessionInfo", () => {
  it("finds the latest session_info name in a tail chunk", () => {
    const tail = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: "x" } }),
      JSON.stringify({ type: "session_info", name: "Old name" }),
      JSON.stringify({ type: "session_info", name: "Latest name" }),
    ].join("\n");
    const buf = Buffer.from(tail);
    const result = scanTailForSessionInfo(buf, buf.length);
    expect(result.found).toBe(true);
    expect(result.name).toBe("Latest name");
  });

  it("returns found:false when the tail has no session_info", () => {
    const tail = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: "x" } }),
      JSON.stringify({ type: "custom", customType: "x" }),
    ].join("\n");
    const buf = Buffer.from(tail);
    const result = scanTailForSessionInfo(buf, buf.length);
    expect(result.found).toBe(false);
    expect(result.name).toBeUndefined();
  });

  it("treats an empty/whitespace name as an explicit clear", () => {
    const tail = [
      JSON.stringify({ type: "session_info", name: "Old name" }),
      JSON.stringify({ type: "session_info", name: "   " }),
    ].join("\n");
    const buf = Buffer.from(tail);
    const result = scanTailForSessionInfo(buf, buf.length);
    expect(result.found).toBe(true);
    expect(result.name).toBeUndefined();
  });

  it("skips a partial line at the read-start boundary", () => {
    // First line is partial JSON (cut off at the tail read-start boundary);
    // JSON.parse fails on it and it is skipped.
    const tail = [
      '{"type":"message","message":{"role":"assistant","content":"trunca',
      JSON.stringify({ type: "session_info", name: "Found after partial" }),
    ].join("\n");
    const buf = Buffer.from(tail);
    const result = scanTailForSessionInfo(buf, buf.length);
    expect(result.found).toBe(true);
    expect(result.name).toBe("Found after partial");
  });
});

describe("loadSessionHeader tail read (session_info at EOF)", () => {
  const testDir = join(tmpdir(), "pi-fast-resume-tail-test-" + process.pid);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("recovers a session name appended at EOF past the forward pass's stop point", () => {
    // Mirrors the reported bug: a large first user message (e.g. a <skill>
    // injection) forces the forward past one read chunk, and the rename's
    // session_info sits at EOF beyond it. The tail read must recover the name.
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "big.jsonl");
    const oversized = "x".repeat(20_000); // forces the first user line past one read chunk
    const lines = [
      JSON.stringify({ type: "session", id: "abc", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } }),
      JSON.stringify({ type: "session_info", name: "Renamed at EOF" }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.name).toBe("Renamed at EOF");
    // The streaming forward read now recovers the oversized first user message
    // too — previously a fixed 16KB head window truncated it mid-JSON and it
    // showed as "(no messages)". The line spans past one read chunk and is
    // assembled across chunks before parsing.
    expect(header!.firstMessage).toBe(oversized);
    expect(header!.messageCount).toBe(1);
    expect(st.size).toBeGreaterThan(16_384);
  });

  it("handles a session_info clear (empty name) at EOF past the forward stop", () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "cleared.jsonl");
    const oversized = "y".repeat(20_000);
    const lines = [
      JSON.stringify({ type: "session", id: "abc", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } }),
      JSON.stringify({ type: "session_info", name: "First rename" }),
      JSON.stringify({ type: "session_info", name: "   " }), // explicit clear at EOF
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.name).toBeUndefined();
  });

  it("still reads the head name for small files (no tail read)", () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "small.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "abc", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "session_info", name: "Small session name" }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.name).toBe("Small session name");
    expect(st.size).toBeLessThanOrEqual(16_384);
  });
});

describe("loadSessionHeader streaming forward read", () => {
  // The forward pass reads complete lines and stops at the first user message.
  // There is no fixed byte window — a first user message of any size is read in
  // full (assembled across read chunks) and parsed correctly. This is the fix
  // for oversized first user messages (<skill> injections, long pastes, base64
  // images) that previously truncated mid-JSON and showed as "(no messages)".
  const testDir = join(tmpdir(), "pi-fast-resume-stream-test-" + process.pid);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("recovers an oversized first user message that spans multiple read chunks", () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "oversized.jsonl");
    // 50KB user message — well past the 16KB read granularity, forcing the
    // reader to assemble the line across at least 4 chunks before parsing.
    const oversized = "a".repeat(50_000);
    const lines = [
      JSON.stringify({ type: "session", id: "big", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.firstMessage).toBe(oversized);
    expect(header!.messageCount).toBe(1);
    expect(st.size).toBeGreaterThan(16_384);
  });

  it("decodes multi-byte content that straddles a read-chunk boundary", () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "multibyte.jsonl");
    // A long multi-byte user message forces the reader to split a UTF-8
    // sequence across chunk boundaries; the StringDecoder must reassemble it.
    const msg = "あ".repeat(20_000); // 3 bytes/char → ~60KB, spans several chunks
    const lines = [
      JSON.stringify({ type: "session", id: "mb", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: msg }] } }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.firstMessage).toBe(msg);
  });

  it("stops forward at the first user message and uses stat mtime (partial)", () => {
    // Forward stops at the first user message even when more bytes follow.
    // Since it did not reach EOF, modified falls back to stat mtime.
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "partial.jsonl");
    const oldMsgTime = 1_000_000_000_000; // 2001 — clearly older than stat mtime
    const lines = [
      JSON.stringify({ type: "session", id: "p", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "thinking", timestamp: oldMsgTime } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "first user", timestamp: oldMsgTime } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "reply", timestamp: oldMsgTime } }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.firstMessage).toBe("first user");
    // messageCount reflects only the entries seen before the forward pass
    // stopped at the first user message (here: 2 — the assistant + the user).
    expect(header!.messageCount).toBe(2);
    // Partial read → stat mtime (truncated to integer ms by Date), not the
    // stale old message timestamps.
    expect(header!.modified.getTime()).toBe(Math.floor(st.mtimeMs));
  });

  it("handles a <skill>-injection first user message (the reported case)", () => {
    // Reproduces the neuralwatt/cdp session: a <skill> wrapper (~16KB) as the
    // first user message, never renamed. Previously showed "(no messages)";
    // now the full skill text is the displayed firstMessage, matching pi-core.
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "skill.jsonl");
    const skillBody = "# Skill body\nline 2\n".repeat(2_000); // ~36KB
    const skillText = `<skill name="cdp" location="/x/SKILL.md">\n${skillBody}</skill>`;
    const lines = [
      JSON.stringify({ type: "session", id: "sk", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "model_change", to: "m" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: skillText }] } }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.firstMessage).toBe(skillText);
    expect(header!.name).toBeUndefined();
  });

  it("does not recover a session_info beyond the tail bound (documented tradeoff)", () => {
    // The tail read covers up to TAIL_READ_SIZE bytes from EOF. A rename
    // followed by more than that much continued activity is missed and falls
    // back to firstMessage — the documented tradeoff vs scanning the whole file.
    // This test pins that behavior so the tradeoff is explicit.
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "deep-rename.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "d", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "session_info", name: "Renamed then buried" }),
    ];
    // Append > 32KB of trailing activity so the rename is beyond the tail bound.
    for (let i = 0; i < 2_000; i++) {
      lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: `activity ${i} ` + "y".repeat(30) } }));
    }
    writeFileSync(filePath, lines.join("\n") + "\n");

    const st = statSync(filePath);
    const header = loadSessionHeader({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });

    expect(header).not.toBeNull();
    expect(header!.firstMessage).toBe("first");
    // The rename is buried under >32KB of trailing activity → not recovered.
    expect(header!.name).toBeUndefined();
    expect(st.size).toBeGreaterThan(32_768);
  });
});

describe("deferred name resolution (forward-only + resolveSessionName)", () => {
  // The picker displays rows immediately with a forward-only header (no tail
  // read), then resolves rename names in the background via resolveSessionName.
  // For any session, forward + resolve must equal the combined loadSessionHeader
  // — that equivalence is the contract the picker relies on.
  const testDir = join(tmpdir(), "pi-fast-resume-deferred-" + process.pid);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeSession(file: string, lines: unknown[]) {
    mkdirSync(testDir, { recursive: true });
    const p = join(testDir, file);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const st = statSync(p);
    return { path: p, mtimeMs: st.mtimeMs, size: st.size };
  }

  it("forward-only header omits a rename that lives past the forward stop", () => {
    // First user message is oversized, so the forward pass stops well before
    // the session_info at EOF. Forward-only must NOT see the rename name.
    const oversized = "x".repeat(20_000);
    const meta = writeSession("renamed.jsonl", [
      { type: "session", id: "a", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } },
      { type: "session_info", name: "Renamed at EOF" },
    ]);

    const fwd = loadSessionHeaderForward(meta);
    expect(fwd).not.toBeNull();
    expect(fwd!.firstMessage).toBe(oversized);
    // No tail read → the rename (past the forward stop) is not yet visible.
    expect(fwd!.name).toBeUndefined();
  });

  it("resolveSessionName recovers the rename from the tail", () => {
    const oversized = "x".repeat(20_000);
    const meta = writeSession("renamed.jsonl", [
      { type: "session", id: "a", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } },
      { type: "session_info", name: "Renamed at EOF" },
    ]);

    const tail = resolveSessionName(meta);
    expect(tail.found).toBe(true);
    expect(tail.name).toBe("Renamed at EOF");
  });

  it("forward + resolveSessionName equals the combined loadSessionHeader", () => {
    // The core contract for the deferred model: applying the tail result to
    // the forward-only header yields exactly what the combined load produces.
    const oversized = "x".repeat(20_000);
    const meta = writeSession("equiv.jsonl", [
      { type: "session", id: "a", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } },
      { type: "session_info", name: "First rename" },
      { type: "message", message: { role: "assistant", content: "work" } },
      { type: "session_info", name: "Latest rename" },
    ]);

    const combined = loadSessionHeader(meta);
    const fwd = loadSessionHeaderForward(meta);
    const tail = resolveSessionName(meta);
    const resolvedName = tail.found ? tail.name : fwd?.name;

    expect(combined).not.toBeNull();
    expect(fwd).not.toBeNull();
    expect(resolvedName).toBe(combined!.name); // "Latest rename"
    expect(resolvedName).toBe("Latest rename");
  });

  it("resolveSessionName treats an empty name as an explicit clear (found:true)", () => {
    const oversized = "x".repeat(20_000);
    const meta = writeSession("cleared.jsonl", [
      { type: "session", id: "a", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } },
      { type: "session_info", name: "Named" },
      { type: "session_info", name: "   " }, // explicit clear at EOF
    ]);

    const tail = resolveSessionName(meta);
    // found:true signals the picker to override the forward name — with
    // undefined (the clear), not fall back to it.
    expect(tail.found).toBe(true);
    expect(tail.name).toBeUndefined();
  });

  it("resolveSessionName returns found:false when no session_info is in the tail", () => {
    // Un-named session: no session_info anywhere → the picker keeps the
    // forward-only name (undefined) and shows firstMessage. No override.
    const oversized = "x".repeat(20_000);
    const meta = writeSession("unnamed.jsonl", [
      { type: "session", id: "a", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: oversized }] } },
      { type: "message", message: { role: "assistant", content: "reply" } },
    ]);

    const tail = resolveSessionName(meta);
    expect(tail.found).toBe(false);
    expect(tail.name).toBeUndefined();
  });

  it("resolveSessionName on a missing file returns found:false (no throw)", () => {
    const meta = { path: join(testDir, "does-not-exist.jsonl"), mtimeMs: 0, size: 0 };
    const tail = resolveSessionName(meta);
    expect(tail.found).toBe(false);
    expect(tail.name).toBeUndefined();
  });

  it("loadSessionHeadersForward mirrors non-name fields; resolveSessionName recovers names", () => {
    // The batch forward-only path must produce headers whose id/cwd/firstMessage/
    // modified/parentSessionPath match a combined load. `name` may differ when
    // the latest session_info lives past the forward stop (the common case —
    // the forward pass stops at the first user message, before any rename at
    // EOF); resolveSessionName then recovers it. This guards the all-scope
    // background batch load's forward-only + deferred-resolve contract.
    const common = [
      { type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z", cwd: "/p" },
      { type: "message", message: { role: "user", content: "first" } },
    ];
    const m1 = writeSession("s1.jsonl", [...common, { type: "session_info", name: "N1" }]);
    const m2 = writeSession("s2.jsonl", [...common, { type: "session_info", name: "N2" }]);

    const fwd = loadSessionHeadersForward([m1, m2]);
    const full = loadSessionHeaders([m1, m2]);
    expect(fwd).toHaveLength(2);
    expect(full).toHaveLength(2);

    for (const f of fwd) {
      const c = full.find((h) => h.path === f.path)!;
      // Non-name fields are identical between forward-only and combined.
      expect(f.id).toBe(c.id);
      expect(f.cwd).toBe(c.cwd);
      expect(f.firstMessage).toBe(c.firstMessage);
      expect(f.modified.getTime()).toBe(c.modified.getTime());
      expect(f.parentSessionPath).toBe(c.parentSessionPath);
      // The rename lives after the first user message → forward-only doesn't see
      // it; resolveSessionName recovers it, matching the combined name.
      expect(f.name).toBeUndefined();
      const tail = resolveSessionName({ path: f.path, mtimeMs: c.modified.getTime(), size: statSync(f.path).size });
      const resolvedName = tail.found ? tail.name : f.name;
      expect(resolvedName).toBe(c.name);
    }
  });
});
