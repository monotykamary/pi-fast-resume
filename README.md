<div align="center">

# ⚡ pi-fast-resume

**Instant session picker for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Reads 16KB per file instead of the full JSONL — first results in **6ms**._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

> **`/resume` takes 5.6 seconds** when you have 1,700+ sessions.
> pi-fast-resume's `/fast-resume` takes **6 milliseconds**.

Same picker UI and keybindings as `/resume`. The difference is pi-fast-resume never reads beyond the first 16KB of any session file. Headers, names, first messages — they all live in the first few lines. Everything after that is full message history the picker never shows. Search matches against the first message only (see [Known Limitations](#known-limitations)).

```
──────────────────────────────────────────────────────────

Resume Session (Current Folder)       ◉ Current Folder | ○ All  Name: All  Sort: Threaded
Tab scope · re:<pattern> regex · "phrase" exact
Ctrl+S sort · Ctrl+N named · Ctrl+D delete · Ctrl+P path (off) · Ctrl+R rename

search: fix auth bug_

› Fix the auth bypass in middleware                    34 2m
  Add rate limiting to API                             98 5h
  Refactor user service                              156 1d
  Auth refactor                                       67 3d

──────────────────────────────────────────────────────────
```

## Benchmarks

Tested with **1,771 sessions, 1.46 GB** of JSONL data on disk.

| Approach                          | First paint  | Full load |
| --------------------------------- | ------------ | --------- |
| Built-in `/resume`                | **5,600 ms** | 5,600 ms  |
| `node:sqlite` indexed query       | 52 ms        | 52 ms     |
| DuckDB persistent index           | 49 ms        | 49 ms     |
| **pi-fast-resume (partial read)** | **6 ms**     | ~580 ms   |
| DuckDB NDJSON full scan           | 2,560 ms     | 2,560 ms  |

<details>
<summary><strong>Full benchmark table</strong></summary>

| Approach                                    | Time      | Notes                                      |
| ------------------------------------------- | --------- | ------------------------------------------ |
| `SessionManager.listAll()` (current)        | ~5,600 ms | Full parse of every file                   |
| DuckDB `read_ndjson` full query             | ~2,560 ms | Still reads all 1.46 GB, but multithreaded |
| Node.js partial read (16 KB/file)           | ~730 ms   | All 1,771 sessions                         |
| DuckDB persistent index (query all)         | ~49 ms    | After one-time build                       |
| `node:sqlite` persistent index (query)      | ~52 ms    | Zero external deps                         |
| **pi-fast-resume, first 30 sessions**       | **~6 ms** | **Streaming display**                      |
| pi-fast-resume, stale-check for incremental | ~74 ms    | Compare mtimes against last load           |
| DuckDB CLI → JSON → Node parse              | ~121 ms   | Shell-out approach                         |
| `node:sqlite` FTS5 search                   | ~0 ms     | Indexed full-text search                   |

</details>

## Install

**With `pi install`** (recommended):

```bash
pi install https://github.com/monotykamary/pi-fast-resume
```

**Manual** — add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/monotykamary/pi-fast-resume"]
}
```

**Local development** — add the extension path directly:

```json
{
  "extensions": ["./path/to/pi-fast-resume/fast-resume.ts"]
}
```

Reload with `/reload` after any install method.

## Usage

### `/fast-resume` command

```
/fast-resume              Open picker (current project)
/fast-resume auth bug     Open picker pre-filtered to "auth bug"
```

### Keyboard shortcut

| Shortcut       | Action                      |
| -------------- | --------------------------- |
| `Ctrl+Shift+F` | Open the fast resume picker |

### Picker controls

Identical to built-in `/resume`:

| Key          | Action                                        |
| ------------ | --------------------------------------------- |
| `↑` / `↓`   | Navigate sessions                             |
| `Enter`      | Switch to selected session                    |
| `Esc`        | Cancel                                        |
| `Tab`        | Toggle scope — current project ↔ all sessions |
| `Ctrl+S`     | Toggle sort — Threaded / Recent / Fuzzy       |
| `Ctrl+N`     | Toggle name filter — All / Named              |
| `Ctrl+P`     | Toggle session file path display              |
| `Ctrl+D`     | Delete selected session (with confirmation)   |
| `Ctrl+R`     | Rename selected session                       |
| typing       | Filter sessions by text / regex / exact match |

### Scope

The picker opens in **current project** scope, showing only sessions whose working directory matches your current `cwd`.

Press `Tab` to switch to **all sessions** — shows every session pi knows about, with the project path displayed for each entry.

## How it works

```
stat() all .jsonl files ──────► sort by mtime ──────► read 16KB of top 30
      (~100ms)                   (recent first)          (~6ms)
                                                            │
                                                            ▼
                                                    ┌─────────────────┐
                                                    │  Show picker    │
                                                    │  immediately    │
                                                    └────────┬────────┘
                                                             │
                                              Background: load rest in batches of 50
                                              (non-blocking via setImmediate)
```

1. **`stat()` all session files** — collect paths and mtimes (~100 ms for 1,700 files)
2. **Sort by mtime descending** — most recent sessions first
3. **Read first 16KB** of the top 30 files — extract header, name, first user message (~6 ms)
4. **Show picker** — user can navigate, filter, and select immediately
5. **Background load** — remaining sessions stream in batches of 50, non-blocking
6. **Tab to switch scope** — filter to current project or show everything

No indexing. No database. No persistent state. Just reads the files on disk.

## Why not index?

An indexed approach would be faster for subsequent queries, but at the cost of real complexity:

|                     | Partial read        | Indexed (SQLite / DuckDB)         |
| ------------------- | ------------------- | --------------------------------- |
| First open          | 6 ms                | 2–4 s (index build)               |
| Subsequent opens    | 6 ms (always fresh) | 50 ms + stale check               |
| State to manage     | None                | Index file, staleness, corruption |
| Dependencies        | None                | `node:sqlite` or DuckDB binary    |
| Freshness guarantee | Always              | Requires staleness detection      |

6 ms is fast enough. The data is always fresh because it's read from disk every time. No staleness bugs, no index corruption, no extra files in `~/.pi/`.

## Hijack mode

pi's built-in `/resume` is handled inside the interactive mode's `onSubmit` callback — it returns early before extension commands or input events are ever checked. Extensions **cannot intercept built-in commands** directly.

However, pi-fast-resume can **prototype-patch** `InteractiveMode.showSessionSelector` to intercept both the `/resume` command and the `app.session.resume` keybinding. Hijack mode is **on by default** — `/resume` opens the fast picker unless you opt out.

- `/resume` opens the **fast** picker instead of the built-in one
- `Ctrl+Shift+R` (or your mapped key) also opens the fast picker
- `/fast-resume` is not registered (no duplicate command)
- `pi -r` / `pi --resume` are **not** affected (they run before the interactive mode starts)

### Disable

Create or edit `~/.pi/agent/extensions/pi-fast-resume.json`:

```json
{
  "hijackResume": false
}
```

Then reload with `/reload`. To re-enable, set `hijackResume` to `true` (or delete the key) and reload.

### How it works

On load, the extension patches `InteractiveMode.prototype.showSessionSelector` to open the fast picker via `ctx.ui.custom()`. On `session_shutdown` (reload, quit, session switch), the prototype is restored. The patch guards against API changes — if `showSessionSelector` doesn't exist or the runtime can't produce an `ExtensionCommandContext`, it falls back to the original.

## Similar extensions

| Extension                                                        | Approach                       | Gap                                               |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| [pi-sessions](https://github.com/thurstonsand/pi-sessions)       | Search, indexing, auto-titling | Session picker still uses `SessionManager.list()` |
| [pi-session-search](https://github.com/samfoy/pi-session-search) | FTS5 SQLite for search queries | Index for search, not for the picker              |
| [pi-session-manager](https://github.com/Dwsy/pi-session-manager) | Full desktop app (Tauri)       | External app, not integrated into pi              |

None optimize the `/resume` picker itself — they either still fully parse every file or are standalone applications.

## Known Limitations

The 16KB partial-read tradeoff that gives pi-fast-resume its speed comes with one functional gap vs. the built-in `/resume`:

| Area | Built-in `/resume` | pi-fast-resume | Impact |
| ---- | ------------------ | -------------- | ------ |
| **Search depth** | Matches against **all messages** in every session (`allMessagesText`) | Matches against **first message only** (`firstMessage`) + name + id + cwd | A query like `fix oauth` won't find a session where "fix oauth" appears in the 5th message but not the 1st. Name/id/cwd matches still work. |

All other features — tree view, regex/exact-phrase search, sort modes, scope toggle, delete, rename, path display — are identical to the built-in picker.

## License

[MIT](./LICENSE)
