/**
 * Session search logic — ported from pi-core's session-selector-search.js.
 *
 * Supports three query modes:
 *   - Fuzzy tokens (default): each token fuzzy-matches against session text
 *   - Regex: re:<pattern> — RegExp search against session text
 *   - Exact phrase: "phrase" — case-insensitive substring match
 *
 * Also provides tree-building utilities for threaded sort mode.
 */

import { fuzzyMatch } from "@earendil-works/pi-tui";
import { canonicalizePath, type SessionHeader } from "./scanner.js";

// Search query parsing

export type SearchTokenKind = "fuzzy" | "phrase";

export interface SearchToken {
  kind: SearchTokenKind;
  value: string;
}

export interface ParsedSearch {
  mode: "tokens" | "regex";
  tokens: SearchToken[];
  regex: RegExp | null;
  error?: string;
}

function normalizeWhitespaceLower(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the searchable text for a session.
 *
 * IMPORTANT LIMITATION: pi-core's /resume builds `allMessagesText` from the
 * full file, so search matches against every message in the session. We only
 * read the first 16KB, so we search against `firstMessage` instead. This means
 * queries like `fix oauth` won't match a session where that phrase appears in
 * the 5th message but not the 1st. Name, id, and cwd matches are unaffected.
 *
 * See README "Known Limitations" section for the user-facing explanation.
 */
function getSessionSearchText(session: SessionHeader): string {
  return `${session.id} ${session.name ?? ""} ${session.firstMessage} ${session.cwd}`;
}

export function parseSearchQuery(query: string): ParsedSearch {
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "tokens", tokens: [], regex: null };
  }

  // Regex mode: re:<pattern>
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) {
      return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    }
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { mode: "regex", tokens: [], regex: null, error: msg };
    }
  }

  // Token mode with quote support.
  // Example: foo "node cve" bar
  const tokens: SearchToken[] = [];
  let buf = "";
  let inQuote = false;
  let hadUnclosedQuote = false;

  const flush = (kind: SearchTokenKind) => {
    const v = buf.trim();
    buf = "";
    if (!v) return;
    tokens.push({ kind, value: v });
  };

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      flush("fuzzy");
      continue;
    }
    buf += ch;
  }

  if (inQuote) {
    hadUnclosedQuote = true;
  }

  // If quotes were unbalanced, fall back to plain whitespace tokenization.
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => ({ kind: "fuzzy" as const, value: t })),
      regex: null,
    };
  }

  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

export interface MatchResult {
  matches: boolean;
  score: number;
}

export function matchSession(session: SessionHeader, parsed: ParsedSearch): MatchResult {
  const text = getSessionSearchText(session);

  if (parsed.mode === "regex") {
    if (!parsed.regex) {
      return { matches: false, score: 0 };
    }
    const idx = text.search(parsed.regex);
    if (idx < 0) return { matches: false, score: 0 };
    return { matches: true, score: idx * 0.1 };
  }

  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }

  let totalScore = 0;
  let normalizedText: string | null = null;

  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) {
        normalizedText = normalizeWhitespaceLower(text);
      }
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      const idx = normalizedText.indexOf(phrase);
      if (idx < 0) return { matches: false, score: 0 };
      totalScore += idx * 0.1;
      continue;
    }

    const m = fuzzyMatch(token.value, text);
    if (!m.matches) return { matches: false, score: 0 };
    totalScore += m.score;
  }

  return { matches: true, score: totalScore };
}

export function hasSessionName(session: SessionHeader): boolean {
  return Boolean(session.name?.trim());
}

export type SortMode = "threaded" | "recent" | "relevance";
export type NameFilter = "all" | "named";

/**
 * Filter and sort sessions — matches pi-core's filterAndSortSessions behavior:
 *   - "recent" mode: filter only, keep incoming order (mtime desc)
 *   - "relevance" mode: sort by match score, tie-break by modified desc
 *   - "threaded" mode with query: same as relevance
 *   - No query: return nameFiltered as-is (tree mode is handled separately)
 */
export function filterAndSortSessions(
  sessions: SessionHeader[],
  query: string,
  sortMode: SortMode,
  nameFilter: NameFilter = "all",
): SessionHeader[] {
  const nameFiltered = nameFilter === "all"
    ? sessions
    : sessions.filter((s) => hasSessionName(s));

  const trimmed = query.trim();
  if (!trimmed) return nameFiltered;

  const parsed = parseSearchQuery(query);
  if (parsed.error) return [];

  // Recent mode: filter only, keep incoming order.
  if (sortMode === "recent") {
    const filtered: SessionHeader[] = [];
    for (const s of nameFiltered) {
      const res = matchSession(s, parsed);
      if (res.matches) filtered.push(s);
    }
    return filtered;
  }

  // Relevance / threaded-with-query: sort by score, tie-break by modified desc.
  const scored: { session: SessionHeader; score: number }[] = [];
  for (const s of nameFiltered) {
    const res = matchSession(s, parsed);
    if (!res.matches) continue;
    scored.push({ session: s, score: res.score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.session.modified.getTime() - a.session.modified.getTime();
  });
  return scored.map((r) => r.session);
}

// Tree structure for threaded view

export interface SessionTreeNode {
  session: SessionHeader;
  children: SessionTreeNode[];
}

export interface FlatSessionNode {
  session: SessionHeader;
  depth: number;
  isLast: boolean;
  ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
export function buildSessionTree(sessions: SessionHeader[]): SessionTreeNode[] {
  const byPath = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    const sessionPath = canonicalizePath(session.path) ?? session.path;
    byPath.set(sessionPath, { session, children: [] });
  }

  const roots: SessionTreeNode[] = [];
  for (const session of sessions) {
    const sessionPath = canonicalizePath(session.path) ?? session.path;
    const node = byPath.get(sessionPath);
    if (!node) continue;

    const parentPath = session.parentSessionPath
      ? canonicalizePath(session.parentSessionPath)
      : undefined;

    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children and roots by modified date (descending)
  const sortNodes = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);

  return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
  const result: FlatSessionNode[] = [];

  const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
    result.push({ session: node.session, depth, isLast, ancestorContinues });
    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      // Only show continuation line for non-root ancestors
      const continues = depth > 0 ? !isLast : false;
      walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    walk(roots[i]!, 0, [], i === roots.length - 1);
  }

  return result;
}

/**
 * Build the tree prefix string (├─ └─ │ characters) for a flat node.
 */
export function buildTreePrefix(node: FlatSessionNode): string {
  if (node.depth === 0) {
    return "";
  }
  const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
  const branch = node.isLast ? "└─ " : "├─ ";
  return parts.join("") + branch;
}
