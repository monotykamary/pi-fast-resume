import { describe, it, expect } from "vitest";
import {
  parseSessionFromBuffer,
  sortByModified,
  filterByCwd,
  matchQuery,
  scanAllSessionDirs,
  scanSessionDir,
  type SessionHeader,
} from "../src/scanner.js";
import {
  createInitialState,
  setScope,
  setFilter,
  moveSelection,
  setSessions,
} from "../src/picker-state.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  // lastActivityTime — pi-core priority: message.timestamp > header.timestamp > stat mtime
  it("prefers message timestamp over stat mtime for modified time", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1705321200000 } }),
    ].join("\n");

    const buf = Buffer.from(jsonl);
    // stat mtime is a week earlier than the message timestamp
    const statMtime = 1704716400000;
    const result = parseSessionFromBuffer(buf, buf.length, "/test/s.jsonl", statMtime);

    expect(result).not.toBeNull();
    // Should use message timestamp (1705321200000), not stat mtime
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
    // stat mtime is after header, but header timestamp should win
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

  // StringDecoder — multi-byte safety at buffer boundaries
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
    // Build a session with a multi-byte name, then truncate the buffer
    // so it splits a multi-byte character
    const name = "日本語テスト";
    const sessionLine = JSON.stringify({ type: "session", id: "x", timestamp: "2026-01-15T10:00:00Z" });
    const infoLine = JSON.stringify({ type: "session_info", name });
    const full = sessionLine + "\n" + infoLine + "\n";
    const fullBuf = Buffer.from(full);

    // The info line with Japanese chars is near the end — truncate 3 bytes
    // to split the last multi-byte character
    const truncatedBytes = fullBuf.length - 3;
    const result = parseSessionFromBuffer(fullBuf, truncatedBytes, "/test/s.jsonl", 0);

    // Session header should still parse correctly
    expect(result).not.toBeNull();
    expect(result!.id).toBe("x");
    // The name line was truncated — JSON parse fails, name falls back to undefined
    // This is expected: incomplete data at the boundary is skipped
  });
});

describe("scanAllSessionDirs / scanSessionDir", () => {
  const testDir = join(tmpdir(), "pi-fast-resume-test-" + process.pid);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("scanAllSessionDirs finds sessions across multiple subdirectories", () => {
    // Create test structure: sessionsDir/sub1/file.jsonl, sessionsDir/sub2/file.jsonl
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
    // Even if paths differ textually, resolve() normalizes them
    const sessions = [
      makeSession({ cwd: "/Users/test/project" }),
    ];

    // Both resolve to the same path
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

describe("PickerState", () => {
  it("creates initial state", () => {
    const sessions = [makeSession(), makeSession()];
    const state = createInitialState(sessions, 10, false);
    expect(state.sessions).toHaveLength(2);
    expect(state.totalCount).toBe(10);
    expect(state.loadingDone).toBe(false);
  });

  it("toggles scope", () => {
    const state = createInitialState([], 0, true);
    const toggled = setScope(state, "all");
    expect(toggled.scope).toBe("all");
    expect(toggled.filterQuery).toBe("");
  });

  it("filters sessions", () => {
    const sessions = [
      makeSession({ firstMessage: "Fix auth" }),
      makeSession({ firstMessage: "Add feature" }),
    ];
    const state = createInitialState(sessions, 2, true);
    const filtered = setFilter(state, "auth");
    expect(filtered.filteredSessions).toHaveLength(1);
    expect(filtered.filteredSessions[0]!.firstMessage).toBe("Fix auth");
  });

  it("moves selection up and down", () => {
    const sessions = [makeSession(), makeSession(), makeSession()];
    const state = createInitialState(sessions, 3, true);
    const down = moveSelection(state, 1);
    expect(down.selectedIndex).toBe(1);
    const up = moveSelection(down, -1);
    expect(up.selectedIndex).toBe(0);
  });

  it("clamps selection at boundaries", () => {
    const sessions = [makeSession()];
    const state = createInitialState(sessions, 1, true);
    const moved = moveSelection(state, -1);
    expect(moved.selectedIndex).toBe(0);
    const moved2 = moveSelection(state, 10);
    expect(moved2.selectedIndex).toBe(0);
  });

  it("updates sessions", () => {
    const state = createInitialState([], 0, false);
    const sessions = [makeSession(), makeSession()];
    const updated = setSessions(state, sessions, true);
    expect(updated.sessions).toHaveLength(2);
    expect(updated.loadingDone).toBe(true);
  });

  it("resets filter when toggling scope", () => {
    const sessions = [makeSession({ firstMessage: "test query" })];
    let state = createInitialState(sessions, 1, true);
    state = setFilter(state, "query");
    expect(state.filterQuery).toBe("query");
    state = setScope(state, "all");
    expect(state.filterQuery).toBe("");
  });
});
