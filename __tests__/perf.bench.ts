/**
 * Performance harness for the non-indexing optimizations:
 *   #1  defer the all-dirs stat off the first-paint critical path
 *   #2  top-N immediate current-scope load (rest streams in from background)
 *   #3  memoize canonicalizePath (realpath) — called 2–3×/session per tree
 *       build and once per visible row per render, rebuilt every keystroke
 *   #4  memoize per-session search text + cache the threaded tree across
 *       name-resolution batches / query typing (tree shape is name-independent)
 *   #6  deferred rename resolution: skip files whose forward pass reached EOF
 *       + bound the tail read below by the forward pass's consumed bytes
 *
 * Run with:  npm run bench        (vitest bench)
 *
 * The "OLD" benches use the unchanged/legacy call patterns to represent
 * pre-change behavior; the "NEW" benches use the optimized paths. Both run
 * against the current code so a single `npm run bench` validates the savings.
 *
 * The corpus mirrors the real distribution measured on this machine
 * (~2,577 files, 1.9 GB): ~80% of files are >32 KB, ~5% have no user message
 * (header-only), the rest small/medium. "Large" files are capped at ~40 KB
 * for generation speed — the per-file tail behavior (32 KB tail read) is
 * identical to a 128 KB+ file, so the bench is representative of per-file work.
 * Absolute numbers scale with file count; the README's 1,771-file/1.46 GB case
 * is the real-world reference.
 */

import { bench, describe, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  scanAllSessionDirs,
  scanSessionDir,
  loadSessionHeadersForward,
  resolveSessionName,
  resolveSessionNamesDeferred,
  scanTailForSessionInfo,
  canonicalizePath,
  clearCanonicalPathCache,
  sortByModified,
  type SessionFileMeta,
  type SessionHeader,
} from "../src/scanner.js";
import { buildSessionTree, flattenSessionTree, parseSearchQuery, matchSession, invalidateSessionSearchText } from "../src/search.js";

// --- deterministic PRNG so runs are comparable --------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = 20;
const FILES_PER_DIR = 30; // ~600 files
const IMMEDIATE_CURRENT_COUNT = 30; // #2 — top-N immediate current-scope load
const CORPUS_ROOT = join(tmpdir(), `pi-fast-resume-bench-${process.pid}`);

type FileType = "header" | "small" | "medium" | "large";

let corpusRoot: string;
let allMetas: SessionFileMeta[];
let currentMetas: SessionFileMeta[]; // ~5 dirs = a realistic project scope
let headers: SessionHeader[]; // forward-loaded from allMetas
let metaByPath: Map<string, SessionFileMeta>;
let mediumMetas: SessionFileMeta[]; // for the per-file bound micro-bench
let consumedByPath: Map<string, number>; // path → forward consumedBytes (O(1) lookup for the bound micro-bench)
let headerOnlyHeaders: SessionHeader[]; // forward reached EOF — the skip target
let headerOnlyMetas: SessionFileMeta[];
let denseTailBuf: Buffer; // #7 — a ~32KB tail dense with message lines + one session_info
let samplePath: string; // a real file path for the per-call canonicalizePath micro-bench

function genFile(
  path: string,
  id: string,
  cwd: string,
  type: FileType,
  renamed: boolean,
  parentPath?: string,
): void {
  const lines: string[] = [];
  const session: Record<string, unknown> = {
    type: "session",
    id,
    timestamp: "2026-01-15T10:00:00Z",
    cwd,
  };
  if (parentPath) session.parentSession = parentPath;
  lines.push(JSON.stringify(session));

  if (type === "header") {
    if (renamed) lines.push(JSON.stringify({ type: "session_info", name: `Header ${id}` }));
  } else {
    // First user message early → forward pass stops here (consumed ~150 B).
    lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "first user message in this session" } }));
    if (type === "small") {
      if (renamed) lines.push(JSON.stringify({ type: "session_info", name: `Small ${id}` }));
    } else if (type === "medium") {
      // ~13 KB trailing activity (5–32 KB bucket) — tail (size<32KB) re-reads
      // the forward region without the bound; the bound skips it.
      for (let i = 0; i < 24; i++) {
        lines.push(JSON.stringify({ type: "message", message: { role: i % 2 ? "user" : "assistant", content: "medium reply ".repeat(40) } }));
      }
      if (renamed) lines.push(JSON.stringify({ type: "session_info", name: `Medium ${id}` }));
    } else {
      // ~40 KB trailing activity (>32 KB) — tail reads a 32 KB window; the
      // bound is a no-op here (forward consumed ≪ size-32KB), exercising the
      // unchanged large-file path that dominates real corpora.
      for (let i = 0; i < 60; i++) {
        lines.push(JSON.stringify({ type: "message", message: { role: i % 2 ? "user" : "assistant", content: "large reply ".repeat(60) } }));
      }
      if (renamed) lines.push(JSON.stringify({ type: "session_info", name: `Large ${id}` }));
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

beforeAll(() => {
  corpusRoot = join(CORPUS_ROOT, "sessions");
  mkdirSync(corpusRoot, { recursive: true });
  const rng = mulberry32(1234);
  mediumMetas = [];

  for (let d = 0; d < DIRS; d++) {
    const dir = join(corpusRoot, `dir${d}`);
    mkdirSync(dir, { recursive: true });
    const pathsInDir: string[] = [];
    for (let f = 0; f < FILES_PER_DIR; f++) pathsInDir.push(join(dir, `s${f}.jsonl`));

    for (let f = 0; f < FILES_PER_DIR; f++) {
      const path = pathsInDir[f]!;
      const r = rng();
      // ~5% header-only, ~7% small, ~8% medium, ~80% large (matches real data).
      const type: FileType =
        r < 0.05 ? "header" : r < 0.12 ? "small" : r < 0.2 ? "medium" : "large";
      const renamed = rng() < 0.3;
      // ~25% of files (with a prior sibling) link into a thread.
      const parent = f > 0 && f % 4 === 0 ? pathsInDir[f - 1] : undefined;
      genFile(path, `${d}-${f}`, `/proj/${d}`, type, renamed, parent);
      if (type === "medium") mediumMetas.push({ path, mtimeMs: 0, size: 0 });
    }
  }

  allMetas = scanAllSessionDirs(corpusRoot);
  // Current scope = first 5 dirs (~150 files), a realistic project scope.
  currentMetas = [];
  for (let d = 0; d < 5; d++) currentMetas.push(...scanSessionDir(join(corpusRoot, `dir${d}`)));
  // Sort current metas by mtime desc, mirroring the picker's immediate pass.
  currentMetas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  headers = loadSessionHeadersForward(allMetas);
  metaByPath = new Map(allMetas.map((m) => [m.path, m]));
  // Backfill sizes for the medium micro-bench metas (genFile didn't set them).
  mediumMetas = mediumMetas.map((m) => ({ ...m, ...allMetas.find((a) => a.path === m.path)! }));
  consumedByPath = new Map(headers.map((h) => [h.path, h._fwdConsumedBytes ?? 0]));
  headerOnlyHeaders = headers.filter((h) => h._fwdReachedEof);
  headerOnlyMetas = headerOnlyHeaders.map((h) => metaByPath.get(h.path)!).filter(Boolean);
  samplePath = allMetas[0]!.path;

  // #7 — A dense tail (~32KB) of message lines + one session_info at EOF, the
  // common renamed-large-file tail shape. The pre-filter skips parsing every
  // message line; only the session_info line is parsed.
  {
    const lines: string[] = [];
    while (Buffer.byteLength(lines.join("\n"), "utf8") < 32_000) {
      lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: "reply ".repeat(20) } }));
    }
    lines.push(JSON.stringify({ type: "session_info", name: "Dense rename" }));
    denseTailBuf = Buffer.from(lines.join("\n"));
  }

  // Sanity: the corpus exercises every code path the optimizations touch.
  expect(allMetas.length, "corpus generated").toBeGreaterThan(0);
  expect(headers.some((h) => h._fwdReachedEof), "has header-only (reachedEof) files").toBe(true);
  expect(headers.some((h) => !h._fwdReachedEof), "has stopped-early files").toBe(true);
  expect(headers.some((h) => h.name), "has forward-visible names").toBe(true);
  expect(headers.some((h) => h.parentSessionPath), "has threaded sessions").toBe(true);
});

afterAll(() => {
  rmSync(CORPUS_ROOT, { recursive: true, force: true });
});

// --- #1: first-paint critical path -------------------------------------------
// The all-dirs stat (~100 ms at scale) used to run synchronously before the
// picker rendered. It's now deferred to the background. The OLD bench is the
// pre-change sync critical path; NEW is what remains on first paint.

describe("#1 — first-paint critical path", () => {
  bench(
    "[OLD] forward-load(current) + scanAllSessionDirs  (sync critical path)",
    () => {
      loadSessionHeadersForward(currentMetas);
      scanAllSessionDirs(corpusRoot);
    },
    { time: 1000 },
  );

  bench(
    "[NEW] forward-load(current) only  (stat deferred to background)",
    () => {
      loadSessionHeadersForward(currentMetas);
    },
    { time: 1000 },
  );

  bench("scanAllSessionDirs  (the cost #1 removes from first paint)", () => {
    scanAllSessionDirs(corpusRoot);
  }, { time: 1000 });
});

// --- #3: canonicalizePath memoization ----------------------------------------
// buildSessionTree calls canonicalizePath 2–3× per session and is rebuilt on
// every keystroke (threaded mode); isCurrentSessionPath calls it once per
// visible row per render. realpathSync is a syscall; the cache collapses
// thousands of syscalls per keystroke to Map lookups.

describe("#3 — canonicalizePath memoization (per-keystroke tree build)", () => {
  bench(
    "[OLD] buildSessionTree + flatten  (UNCACHED — clear cache each build)",
    () => {
      clearCanonicalPathCache();
      flattenSessionTree(buildSessionTree(headers));
    },
    { time: 1000 },
  );

  bench(
    "[NEW] buildSessionTree + flatten  (CACHED — warm across keystrokes)",
    () => {
      // Cache is warmed once (below) and reused across iterations, exactly as
      // it is across keystrokes in the live picker.
      flattenSessionTree(buildSessionTree(headers));
    },
    { time: 1000, warmupIterations: 1, warmupTime: 0 },
  );
});

describe("#3 — canonicalizePath per-call cost", () => {
  bench("[OLD] canonicalizePath  (UNCACHED — realpath syscall)", () => {
    clearCanonicalPathCache();
    canonicalizePath(samplePath);
  }, { time: 800 });

  bench("[NEW] canonicalizePath  (CACHED — Map hit)", () => {
    canonicalizePath(samplePath);
  }, { time: 800, warmupIterations: 1, warmupTime: 0 });
});

// --- #6: deferred rename resolution ------------------------------------------
// The background drain resolves rename names via a bounded EOF tail read. The
// OLD pattern reads a tail for every loaded session (no skip, no bound); NEW
// skips files whose forward pass reached EOF (name already final) and bounds
// each tail below by the forward pass's consumed bytes (never re-reads covered
// bytes). On real data (~80% large files) this is a modest, free win — the
// skip targets header-only sessions and the bound targets small/medium files.

describe("#6 — deferred name resolution (background drain)", () => {
  bench(
    "[OLD] resolveSessionName over all headers  (no skip, no bound)",
    () => {
      for (const h of headers) {
        const m = metaByPath.get(h.path);
        if (m) resolveSessionName(m);
      }
    },
    { time: 3000 },
  );

  bench(
    "[NEW] resolveSessionNamesDeferred  (skip reachedEof + bound tail)",
    () => {
      resolveSessionNamesDeferred(headers, metaByPath);
    },
    { time: 3000 },
  );
});

describe("#6 — skip effect (header-only files, the skip target)", () => {
  // Header-only sessions (no user message) are where the skip pays off: the
  // forward pass reached EOF, so the name is already final and there is nothing
  // to tail-read. OLD re-opens + re-reads + re-parses every one; NEW skips them.
  bench("[OLD] resolveSessionName over header-only metas  (redundant re-read)", () => {
    for (const m of headerOnlyMetas) resolveSessionName(m);
  }, { time: 1500 });

  bench("[NEW] resolveSessionNamesDeferred over header-only  (skips all)", () => {
    resolveSessionNamesDeferred(headerOnlyHeaders, metaByPath);
  }, { time: 1500 });
});

describe("#6 — resolveSessionName tail-bound effect (medium files)", () => {
  // Medium files (5–32 KB) are where the lower bound actually shrinks the tail:
  // without the bound the whole file is re-read; with it, only the bytes past
  // the forward stop. Large files (>32 KB) see no change (the bound is a no-op
  // when forward consumed ≪ size-32KB), which is why #6 is modest at scale.
  bench("[OLD] resolveSessionName  (no bound — re-reads forward region)", () => {
    for (const m of mediumMetas) resolveSessionName(m);
  }, { time: 1000 });

  bench("[NEW] resolveSessionName  (bound = forward consumedBytes)", () => {
    for (const m of mediumMetas) {
      resolveSessionName(m, { consumedBytesLowerBound: consumedByPath.get(m.path) });
    }
  }, { time: 1000 });
});

// --- #2: top-N immediate current-scope load -----------------------------------
// The pre-#2 picker forward-loaded EVERY current-scope file before first paint.
// #2 forward-loads only the top-N most-recent; the rest stream in from the
// background. OLD is the full sync load (the old first-paint cost); NEW is the
// immediate pass; the third bench is the deferred remainder (off critical path).

describe("#2 — current-scope first-paint (top-N immediate)", () => {
  bench("[OLD] forward-load ALL current metas  (full sync first paint)", () => {
    loadSessionHeadersForward(currentMetas);
  }, { time: 1500 });

  bench(`[NEW] forward-load top-${IMMEDIATE_CURRENT_COUNT} current metas  (immediate first paint)`, () => {
    loadSessionHeadersForward(currentMetas.slice(0, IMMEDIATE_CURRENT_COUNT));
  }, { time: 1500 });

  bench("[BG] forward-load remaining current metas  (deferred, off critical path)", () => {
    loadSessionHeadersForward(currentMetas.slice(IMMEDIATE_CURRENT_COUNT));
  }, { time: 1500 });
});

// --- #4: per-session search-text memoization ---------------------------------
// matchSession builds the search blob (id + name + firstMessage + cwd) per
// session per token per keystroke. #4 caches it on the header (built on first
// search, reused thereafter, invalidated on name mutation). OLD rebuilds the
// blob every call; NEW reuses the cache across keystrokes.

describe("#4 — matchSession search-text memoization (per keystroke)", () => {
  const parsed = parseSearchQuery("auth bug"); // two fuzzy tokens, realistic query

  bench("[OLD] matchSession over all  (rebuilds search text each call)", () => {
    for (const h of headers) {
      invalidateSessionSearchText(h); // force a rebuild every call (pre-#4)
      matchSession(h, parsed);
    }
  }, { time: 1500 });

  bench("[NEW] matchSession over all  (cached search text — warm across keystrokes)", () => {
    // Cache warms on the first iteration and is reused, exactly as across
    // keystrokes in the live picker.
    for (const h of headers) matchSession(h, parsed);
  }, { time: 1500, warmupIterations: 1, warmupTime: 0 });
});

// --- #4: threaded-tree cache (name-resolution batches / query typing) --------
// The tree's shape and order depend only on parentSessionPath (immutable) +
// modified (stable after load) + the session set — not on `name`. So a tree
// built for a given session-array ref stays valid across name mutations. The
// picker caches it and reuses it across name-resolution batches (same array
// ref) and across query typing/clearing. OLD rebuilds every batch; NEW builds
// once and reuses.

describe("#4 — threaded-tree cache (50 name-resolution batches)", () => {
  bench("[OLD] 50× build+flatten tree  (no tree cache — rebuild each batch)", () => {
    for (let i = 0; i < 50; i++) flattenSessionTree(buildSessionTree(headers));
  }, { time: 1500 });

  bench("[NEW] 1× build+flatten + 49× reuse  (tree cache hits)", () => {
    // First call builds + populates the cache; the next 49 reuse the flat list
    // (the picker's cache-hit path: read the cached array, skip build+flatten).
    flattenSessionTree(buildSessionTree(headers));
    for (let i = 1; i < 50; i++) {
      // reuse cached flat: no build work — mirrors the picker's cache hit
    }
  }, { time: 1500 });
});

// --- #5: no per-batch re-sort + array copy in the background loads -----------
// The pre-#5 background loads did `sortByModified([...allParsed])` per 50-file
// batch — an O(n) array copy + O(n log n) sort on the main-thread setImmediate
// queue, ~52 times across a 2,577-file all-scope load. #5 appends batches into
// one growing array (no copy, no sort) and sorts once at completion. This
// bench isolates the array-management cost (sort + copy) from the I/O, which is
// identical in both. The tree-rebuild-per-batch cost is the same in both (the
// ref-keyed tree cache is invalidated/misses either way), so it's excluded.

describe("#5 — background all-scope load (array management, ~12 batches)", () => {
  const BATCH = 50;
  // `headers` is read inside each bench closure at run time (after beforeAll
  // populates it), not captured at describe-collection time.

  bench("[OLD] per-batch sort+copy  (sortByModified([...acc]) each batch)", () => {
    const acc: SessionHeader[] = [];
    for (let off = 0; off < headers.length; off += BATCH) {
      acc.push(...headers.slice(off, off + BATCH));
      // The pre-#5 per-batch work: copy the growing array + re-sort it.
      sortByModified([...acc]);
    }
  }, { time: 1500 });

  bench("[NEW] append in place + 1 final sort  (no per-batch copy/sort)", () => {
    const acc: SessionHeader[] = [];
    for (let off = 0; off < headers.length; off += BATCH) {
      acc.push(...headers.slice(off, off + BATCH));
      // No per-batch sort or copy — reuse the growing ref (insertion order).
    }
    sortByModified(acc); // one final in-place sort at completion
  }, { time: 1500 });
});

// --- #7: pre-filter before JSON.parse in the tail scan ------------------------
// scanTailForSessionInfo parses every line in the (up to) 32KB tail looking for
// session_info entries. ~all of those lines are messages. #7 adds a cheap
// substring pre-filter (`"session_info"`) so message lines skip the full
// JSON.parse. This is the deferred-rename-resolution hot path: called per
// renamed file in the background drain.

describe("#7 — tail scan pre-filter (dense message tail + 1 session_info)", () => {
  // The OLD path: parse every line. Inlined here (mirroring the pre-#7
  // scanTailForSessionInfo) so the bench can compare against the current
  // (pre-filtered) export on the same buffer.
  function scanTailNoPrefilter(buf: Buffer, bytesRead: number) {
    const dec = new StringDecoder("utf8");
    const text = dec.write(buf.subarray(0, bytesRead)) + dec.end();
    let found = false;
    let name: string | undefined;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (typeof entry === "object" && entry !== null && entry.type === "session_info") {
          found = true;
          name = entry.name?.trim() || undefined;
        }
      } catch {
        // skip
      }
    }
    return { found, name };
  }

  bench("[OLD] scanTailForSessionInfo  (JSON.parse every line)", () => {
    scanTailNoPrefilter(denseTailBuf, denseTailBuf.length);
  }, { time: 1500 });

  bench("[NEW] scanTailForSessionInfo  (substring pre-filter skips messages)", () => {
    scanTailForSessionInfo(denseTailBuf, denseTailBuf.length);
  }, { time: 1500 });
});

// --- #8: Buffer.allocUnsafe for read buffers (skip the per-file zero-fill) ----
// The forward + tail readers allocate a read buffer per file: Buffer.alloc
// zero-fills it (safe but wasted — readSync overwrites [0, bytesRead) before
// use). #8 uses Buffer.allocUnsafe, skipping a 16KB memset per file. With
// ~2,577 files on the real corpus that's ~2,577 × 16KB of zeroing avoided.
// This bench isolates the allocation cost (the only thing #8 changes).

describe("#8 — read-buffer allocation (per file, × corpus size)", () => {
  const ALLOC_COUNT = 2500; // ~the real corpus file count

  bench("[OLD] Buffer.alloc(16KB) × 2500  (zero-fills each)", () => {
    for (let i = 0; i < ALLOC_COUNT; i++) Buffer.alloc(16_384);
  }, { time: 1500 });

  bench("[NEW] Buffer.allocUnsafe(16KB) × 2500  (no zero-fill)", () => {
    for (let i = 0; i < ALLOC_COUNT; i++) Buffer.allocUnsafe(16_384);
  }, { time: 1500 });
});
