/**
 * pi-fast-resume — Fast session picker for pi
 *
 * Reads only enough of each session file to render the title row — streaming
 * forward line by line until the first user message, plus a bounded tail near
 * EOF for the latest rename name — instead of parsing the entire JSONL. Shows
 * results instantly with incremental background loading.
 *
 * Mirrors the exact TUI layout and keybindings of pi's built-in /resume.
 *
 * Usage:
 *   /fast-resume [query]   Open fast session picker (current project scope)
 *
 * Config (~/.pi/agent/extensions/pi-fast-resume.json):
 *   { "hijackResume": false }
 *
 * Hijack mode (on by default, opt-out via config):
 *   { "hijackResume": false }
 *
 *   When enabled, /resume and Ctrl+Shift+R open the fast picker instead.
 *   /fast-resume is not registered (no duplicate). pi -r is not affected.
 *
 * Keys in picker (identical to /resume):
 *   ↑/↓                   Navigate
 *   Tab                   Toggle scope (Current Folder / All)
 *   Ctrl+S                Toggle sort (Threaded / Recent / Fuzzy)
 *   Ctrl+N                Toggle name filter (All / Named)
 *   Ctrl+P                Toggle session path display
 *   Ctrl+D                Delete session (with confirmation)
 *   Ctrl+R                Rename session
 *   Enter                 Select session
 *   Esc                   Cancel
 *   typing                Filter sessions by text search
 *
 * Search modes (identical to /resume):
 *   fuzzy words            foo bar          fuzzy-match each token
 *   exact phrase           "node cve"       case-insensitive substring
 *   regex                  re:<pattern>      RegExp search (case-insensitive)
 *
 * Note on search depth: pi-fast-resume stops reading each file at the first
 * user message, so search matches against id + name + firstMessage + cwd.
 * Upstream /resume matches against all messages (allMessagesText). This
 * tradeoff is by design — the fast load time depends on partial reads.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  InteractiveMode,
  keyHint,
  keyText,
  SessionManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  getKeybindings,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scanAllSessionDirs,
  scanSessionDir,
  loadSessionHeaders,
  sortByModified,
  sortByModifiedDesc,
  filterByCwd,
  canonicalizePath,
  type SessionHeader,
  type SessionFileMeta,
} from "./src/scanner.js";
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
  type NameFilter,
  type PickerScope,
} from "./src/search.js";

const HOME = homedir();

// Config — read from ~/.pi/agent/extensions/pi-fast-resume.json
// Example: { "hijackResume": false, "shortcut": "alt+u" }
// By default hijackResume is true — /resume opens the fast picker
// Set shortcut to register a standalone shortcut (e.g. "ctrl+shift+f")
interface FastResumeConfig {
  hijackResume?: boolean;
  shortcut?: string;
}

const CONFIG_PATH = join(HOME, ".pi", "agent", "extensions", "pi-fast-resume.json");

function readConfig(): FastResumeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as FastResumeConfig;
  } catch {
    return {};
  }
}

export interface FastResumeResult {
  sessionPath?: string;
  cancelled: boolean;
}

type StatusMessage = { type: "info" | "error"; message: string };

// Session loading helpers — mirror SessionManager.list / listAll behavior
// while keeping partial reads.

function loadCurrentSessionsImmediate(
  cwd: string,
  sessionDir: string | undefined,
  usesDefaultSessionDir: boolean,
): SessionHeader[] {
  if (!sessionDir) return [];
  const metas = sortByModifiedDesc(scanSessionDir(sessionDir));
  let headers = loadSessionHeaders(metas);
  if (!usesDefaultSessionDir) {
    // Custom session dirs may contain sessions from multiple cwds; filter to
    // the current one, matching SessionManager.list behavior.
    headers = filterByCwd(headers, cwd);
  }
  return sortByModified(headers);
}

function loadAllSessionMetas(
  sessionDir: string | undefined,
  usesDefaultSessionDir: boolean,
): SessionFileMeta[] {
  if (usesDefaultSessionDir) {
    return scanAllSessionDirs();
  }
  if (!sessionDir) return [];
  return sortByModifiedDesc(scanSessionDir(sessionDir));
}

// ReadonlySessionManager doesn't declare usesDefaultSessionDir, but the
// runtime SessionManager has it. Default to true so old pi versions behave
// like the original default-dir-only fast-resume.
function getUsesDefaultSessionDir(sessionManager: ExtensionCommandContext["sessionManager"]): boolean {
  return (sessionManager as any).usesDefaultSessionDir?.() ?? true;
}

// Helpers

function shortenPath(path: string): string {
  if (!path) return path;
  if (path.startsWith(HOME)) {
    return `~${path.slice(HOME.length)}`;
  }
  return path;
}

function formatSessionDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}

async function deleteSessionFile(sessionPath: string): Promise<{ ok: boolean; method?: string; error?: string }> {
  // Try `trash` first (if installed)
  const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

  const getTrashErrorHint = () => {
    const parts: string[] = [];
    if (trashResult.error) {
      parts.push(trashResult.error.message);
    }
    const stderr = trashResult.stderr?.trim();
    if (stderr) {
      parts.push(stderr.split("\n")[0] ?? stderr);
    }
    if (parts.length === 0) return null;
    return `trash: ${parts.join(" · ").slice(0, 200)}`;
  };

  if (trashResult.status === 0 || !existsSync(sessionPath)) {
    return { ok: true, method: "trash" };
  }

  // Fallback to permanent deletion
  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err) {
    const unlinkError = err instanceof Error ? err.message : String(err);
    const trashErrorHint = getTrashErrorHint();
    const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
    return { ok: false, method: "unlink", error };
  }
}

// Header — mirrors SessionSelectorHeader exactly:
// Line 1: Title (left) │ Scope + Name + Sort indicators (right)
// Line 2: Hint line 1 (scope toggle + search hints)
// Line 3: Hint line 2 (sort/named/delete/path/rename)

class FastResumeHeader implements Component {
  private theme: Theme;
  scope: PickerScope = "current";
  sortMode: SortMode = "threaded";
  nameFilter: NameFilter = "all";
  loading = false;
  loadProgress: { loaded: number; total: number } | null = null;
  showPath = false;
  confirmingDeletePath: string | null = null;
  statusMessage: StatusMessage | null = null;
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;
  showRenameHint = true;
  private requestRender: () => void;

  constructor(theme: Theme, requestRender: () => void) {
    this.theme = theme;
    this.requestRender = requestRender;
  }

  clearStatusTimeout(): void {
    if (!this.statusTimeout) return;
    clearTimeout(this.statusTimeout);
    this.statusTimeout = null;
  }

  setStatusMessage(msg: StatusMessage | null, autoHideMs?: number): void {
    this.clearStatusTimeout();
    this.statusMessage = msg;
    if (!msg || !autoHideMs) return;
    this.statusTimeout = setTimeout(() => {
      this.statusMessage = null;
      this.statusTimeout = null;
      this.requestRender();
    }, autoHideMs);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;

    // Title (left side)
    const title = this.scope === "current"
      ? t.bold("Resume Session (Current Folder)")
      : t.bold("Resume Session (All)");

    // Right side: scope indicators + name filter + sort mode
    let scopeText: string;
    if (this.loading) {
      const progressText = this.loadProgress
        ? `${this.loadProgress.loaded}/${this.loadProgress.total}`
        : "...";
      scopeText = `${t.fg("muted", "○ Current Folder | ")}${t.fg("accent", `Loading ${progressText}`)}`;
    } else if (this.scope === "current") {
      scopeText = `${t.fg("accent", "◉ Current Folder")}${t.fg("muted", " | ○ All")}`;
    } else {
      scopeText = `${t.fg("muted", "○ Current Folder | ")}${t.fg("accent", "◉ All")}`;
    }

    const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
    const sortText = t.fg("muted", "Sort: ") + t.fg("accent", sortLabel);

    const nameLabel = this.nameFilter === "all" ? "All" : "Named";
    const nameText = t.fg("muted", "Name: ") + t.fg("accent", nameLabel);

    const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
    const left = truncateToWidth(title, availableLeft, "");
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

    // Hint lines — same logic as built-in SessionSelectorHeader
    let hintLine1: string;
    let hintLine2: string;

    if (this.confirmingDeletePath !== null) {
      const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
      hintLine1 = t.fg("error", truncateToWidth(confirmHint, width, "…"));
      hintLine2 = "";
    } else if (this.statusMessage) {
      const color = this.statusMessage.type === "error" ? "error" : "accent";
      hintLine1 = t.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
      hintLine2 = "";
    } else {
      const pathState = this.showPath ? "(on)" : "(off)";
      const sep = t.fg("muted", " · ");
      const hint1 = keyHint("tui.input.tab", "scope") + sep + t.fg("muted", 're:<pattern> regex · "phrase" exact');
      const hint2Parts = [
        keyHint("app.session.toggleSort", "sort"),
        keyHint("app.session.toggleNamedFilter", "named"),
        keyHint("app.session.delete", "delete"),
        keyHint("app.session.togglePath", `path ${pathState}`),
      ];
      if (this.showRenameHint) {
        hint2Parts.push(keyHint("app.session.rename", "rename"));
      }
      hintLine1 = truncateToWidth(hint1, width, "…");
      hintLine2 = truncateToWidth(hint2Parts.join(sep), width, "…");
    }

    return [
      `${left}${" ".repeat(spacing)}${rightText}`,
      hintLine1,
      hintLine2,
    ];
  }
}

// Session list — mirrors upstream SessionList rendering exactly:
// search input + blank line + session rows (one line each, right-aligned metadata)
// Supports tree structure in threaded mode (├─ └─ │ prefixes)

class FastResumeSessionList implements Component {
  private theme: Theme;
  allSessions: SessionHeader[] = [];
  filteredNodes: FlatSessionNode[] = [];
  selectedIndex = 0;
  searchInput: Input;
  showCwd = false;
  showPath = false;
  sortMode: SortMode = "threaded";
  nameFilter: NameFilter = "all";
  confirmingDeletePath: string | null = null;
  maxVisible = 10;
  currentSessionCanonicalPath: string | undefined;

  onSelect?: (sessionPath: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  onToggleScope?: () => void;
  onToggleSort?: () => void;
  onToggleNameFilter?: () => void;
  onTogglePath?: (showPath: boolean) => void;
  onDeleteConfirmationChange?: (path: string | null) => void;
  onDeleteSession?: (sessionPath: string) => void;
  onRenameSession?: (sessionPath: string) => void;
  onError?: (msg: string) => void;

  private _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.searchInput.focused = v;
  }

  constructor(theme: Theme, currentSessionFilePath: string | undefined) {
    this.theme = theme;
    this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath ?? "");
    this.searchInput = new Input();

    this.searchInput.onSubmit = () => {
      const selected = this.filteredNodes[this.selectedIndex];
      if (selected) {
        this.onSelect?.(selected.session.path);
      }
    };
  }

  private isCurrentSessionPath(path: string): boolean {
    if (!this.currentSessionCanonicalPath) return false;
    return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
  }

  setSortMode(sortMode: SortMode): void {
    this.sortMode = sortMode;
    this.filterSessions(this.searchInput.getValue());
  }

  setNameFilter(nameFilter: NameFilter): void {
    this.nameFilter = nameFilter;
    this.filterSessions(this.searchInput.getValue());
  }

  setSessions(sessions: SessionHeader[], showCwd: boolean): void {
    this.allSessions = sessions;
    this.showCwd = showCwd;
    this.filterSessions(this.searchInput.getValue());
  }

  setConfirmingDeletePath(path: string | null): void {
    this.confirmingDeletePath = path;
    this.onDeleteConfirmationChange?.(path);
  }

  startDeleteConfirmationForSelectedSession(): void {
    const selected = this.filteredNodes[this.selectedIndex];
    if (!selected) return;
    if (this.isCurrentSessionPath(selected.session.path)) {
      this.onError?.("Cannot delete the currently active session");
      return;
    }
    this.setConfirmingDeletePath(selected.session.path);
  }

  getSelectedSessionPath(): string | undefined {
    const selected = this.filteredNodes[this.selectedIndex];
    return selected?.session.path;
  }

  filterSessions(query: string): void {
    const nameFiltered = this.nameFilter === "all"
      ? this.allSessions
      : this.allSessions.filter(hasSessionName);

    const trimmed = query.trim();

    if (this.sortMode === "threaded" && !trimmed) {
      // Threaded mode without search: show tree structure
      const roots = buildSessionTree(nameFiltered);
      this.filteredNodes = flattenSessionTree(roots);
    } else {
      // Other modes or with search: flat list via filterAndSortSessions
      const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode);
      this.filteredNodes = filtered.map((session) => ({
        session,
        depth: 0,
        isLast: true,
        ancestorContinues: [],
      }));
    }

    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredNodes.length - 1),
    );
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // Search input
    lines.push(...this.searchInput.render(width));
    lines.push(""); // Blank line after search

    if (this.filteredNodes.length === 0) {
      let emptyMessage: string;
      if (this.nameFilter === "named") {
        const toggleKey = keyText("app.session.toggleNamedFilter");
        if (this.showCwd) {
          emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
        } else {
          emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
        }
      } else if (this.showCwd) {
        emptyMessage = "  No sessions found";
      } else {
        emptyMessage = "  No sessions in current folder. Press Tab to view all.";
      }
      lines.push(t.fg("muted", truncateToWidth(emptyMessage, width, "…")));
      return lines;
    }

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredNodes.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredNodes.length);

    for (let i = startIndex; i < endIndex; i++) {
      const node = this.filteredNodes[i]!;
      const session = node.session;
      const isSelected = i === this.selectedIndex;
      const isConfirmingDelete = session.path === this.confirmingDeletePath;
      const isCurrent = this.isCurrentSessionPath(session.path);
      const hasName = !!session.name;

      // Build tree prefix
      const prefix = buildTreePrefix(node);

      // Session display text
      const displayText = (session.name ?? session.firstMessage)
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim();

      // Right side: path (if toggled) + cwd (if all scope) + message count + age
      const age = formatSessionDate(session.modified);
      const msgCount = String(session.messageCount);
      let rightPart = `${msgCount} ${age}`;
      if (this.showCwd && session.cwd) {
        rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
      }
      if (this.showPath) {
        rightPart = `${shortenPath(session.path)} ${rightPart}`;
      }

      // Cursor
      const cursor = isSelected ? t.fg("accent", "› ") : "  ";

      // Calculate available width for message
      const prefixWidth = visibleWidth(prefix);
      const rightWidth = visibleWidth(rightPart) + 2;
      const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 for cursor
      const truncatedMsg = truncateToWidth(displayText, Math.max(10, availableForMsg), "…");

      // Style message — same color logic as built-in
      let messageColor: Parameters<Theme["fg"]>[0] | null = null;
      if (isConfirmingDelete) {
        messageColor = "error";
      } else if (isCurrent) {
        messageColor = "accent";
      } else if (hasName) {
        messageColor = "warning";
      }
      let styledMsg = messageColor ? t.fg(messageColor, truncatedMsg) : truncatedMsg;
      if (isSelected) {
        styledMsg = t.bold(styledMsg);
      }

      // Build line — same layout as built-in
      const leftPart = cursor + t.fg("dim", prefix) + styledMsg;
      const leftWidth = visibleWidth(leftPart);
      const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
      const styledRight = t.fg(isConfirmingDelete ? "error" : "dim", rightPart);
      let line = leftPart + " ".repeat(spacing) + styledRight;
      if (isSelected) {
        line = t.bg("selectedBg", line);
      }
      lines.push(truncateToWidth(line, width));
    }

    // Scroll indicator
    if (startIndex > 0 || endIndex < this.filteredNodes.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredNodes.length})`;
      lines.push(t.fg("muted", truncateToWidth(scrollText, width, "")));
    }

    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // Handle delete confirmation state first — intercept all keys
    if (this.confirmingDeletePath !== null) {
      if (kb.matches(data, "tui.select.confirm")) {
        const pathToDelete = this.confirmingDeletePath;
        this.setConfirmingDeletePath(null);
        this.onDeleteSession?.(pathToDelete);
        return;
      }
      if (kb.matches(data, "tui.select.cancel")) {
        this.setConfirmingDeletePath(null);
        return;
      }
      // Ignore all other keys while confirming
      return;
    }

    if (kb.matches(data, "tui.input.tab")) {
      this.onToggleScope?.();
      return;
    }

    if (kb.matches(data, "app.session.toggleSort")) {
      this.onToggleSort?.();
      return;
    }

    if (kb.matches(data, "app.session.toggleNamedFilter")) {
      this.onToggleNameFilter?.();
      return;
    }

    // Ctrl+P: toggle path display
    if (kb.matches(data, "app.session.togglePath")) {
      this.showPath = !this.showPath;
      this.onTogglePath?.(this.showPath);
      return;
    }

    // Ctrl+D: initiate delete confirmation
    if (kb.matches(data, "app.session.delete")) {
      this.startDeleteConfirmationForSelectedSession();
      return;
    }

    // Ctrl+R: rename selected session
    if (kb.matches(data, "app.session.rename")) {
      const selected = this.filteredNodes[this.selectedIndex];
      if (selected) {
        this.onRenameSession?.(selected.session.path);
      }
      return;
    }

    // Ctrl+Backspace: convenience alias for delete when search is empty
    if (kb.matches(data, "app.session.deleteNoninvasive")) {
      if (this.searchInput.getValue().length > 0) {
        this.searchInput.handleInput(data);
        this.filterSessions(this.searchInput.getValue());
        return;
      }
      this.startDeleteConfirmationForSelectedSession();
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
    } else if (kb.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisible);
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.filteredNodes[this.selectedIndex];
      if (selected && this.onSelect) {
        this.onSelect(selected.session.path);
      }
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
    } else {
      // Pass everything else to search input
      this.searchInput.handleInput(data);
      this.filterSessions(this.searchInput.getValue());
    }
  }
}

// Top-level component — mirrors SessionSelectorComponent layout exactly:
// Spacer(1) → DynamicBorder → Spacer(1) → Header → Spacer(1) → SessionList → Spacer(1) → DynamicBorder
// Or, when in rename mode: same layout wrapping a rename panel

class FastResumePicker extends Container {
  private header: FastResumeHeader;
  private sessionList: FastResumeSessionList;
  private renameInput: Input;
  private theme: Theme;
  private tuiRequestRender: () => void;
  private done: (result: FastResumeResult) => void;

  private scope: PickerScope = "current";
  private sortMode: SortMode = "threaded";
  private nameFilter: NameFilter = "all";
  private currentSessions: SessionHeader[] | null = null;
  private allSessions: SessionHeader[] | null = null;
  private currentLoading = false;
  private allLoading = false;

  private allMetas: SessionFileMeta[] = [];
  private loadingAbort: AbortController | null = null;
  private allLoadSeq = 0;

  private mode: "list" | "rename" = "list";
  private renameTargetPath: string | null = null;

  private cwd: string;
  private sessionDir: string | undefined;
  private usesDefaultSessionDir: boolean;

  // Focusable — propagate to sessionList or renameInput
  private _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.sessionList.focused = v;
    this.renameInput.focused = v;
    if (v && this.mode === "rename") {
      this.renameInput.focused = true;
    }
  }

  private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
    this.addChild(new Spacer(1));
    if (options?.showHeader ?? true) {
      this.addChild(this.header);
      this.addChild(new Spacer(1));
    }
    this.addChild(content);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
  }

  constructor(
    theme: Theme,
    currentCwd: string,
    sessionDir: string | undefined,
    usesDefaultSessionDir: boolean,
    currentSessionPath: string | undefined,
    initialCurrentSessions: SessionHeader[],
    allMetas: SessionFileMeta[],
    allSessions: SessionHeader[] | null,
    done: (result: FastResumeResult) => void,
    tuiRequestRender: () => void,
    initialQuery?: string,
  ) {
    super();
    this.theme = theme;
    this.done = done;
    this.tuiRequestRender = tuiRequestRender;
    this.allMetas = allMetas;
    this.cwd = currentCwd;
    this.sessionDir = sessionDir;
    this.usesDefaultSessionDir = usesDefaultSessionDir;

    // Create header
    this.header = new FastResumeHeader(theme, tuiRequestRender);

    // Create rename input
    this.renameInput = new Input();
    this.renameInput.onSubmit = (value) => {
      void this.confirmRename(value);
    };

    // Create session list
    this.sessionList = new FastResumeSessionList(theme, currentSessionPath);
    this.currentSessions = initialCurrentSessions;
    this.allSessions = allSessions;

    // Set initial data into the list
    this.sessionList.setSessions(initialCurrentSessions, false);

    // Seed an optional initial query from /fast-resume <query>
    if (initialQuery !== undefined && initialQuery !== "") {
      this.sessionList.searchInput.setValue(initialQuery);
      this.sessionList.filterSessions(initialQuery);
    }

    // Wire session list events
    this.sessionList.onSelect = (sessionPath) => {
      this.header.clearStatusTimeout();
      this.loadingAbort?.abort();
      this.done({ sessionPath, cancelled: false });
    };
    this.sessionList.onCancel = () => {
      this.header.clearStatusTimeout();
      this.loadingAbort?.abort();
      this.done({ cancelled: true });
    };
    this.sessionList.onExit = () => {
      this.header.clearStatusTimeout();
      this.loadingAbort?.abort();
      this.done({ cancelled: true });
    };
    this.sessionList.onToggleScope = () => this.toggleScope();
    this.sessionList.onToggleSort = () => this.toggleSortMode();
    this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
    this.sessionList.onTogglePath = (showPath) => {
      this.header.showPath = showPath;
      this.tuiRequestRender();
    };
    this.sessionList.onDeleteConfirmationChange = (path) => {
      this.header.confirmingDeletePath = path;
      this.tuiRequestRender();
    };
    this.sessionList.onError = (msg) => {
      this.header.setStatusMessage({ type: "error", message: msg }, 3000);
      this.tuiRequestRender();
    };
    this.sessionList.onDeleteSession = async (sessionPath) => {
      const result = await deleteSessionFile(sessionPath);
      if (result.ok) {
        // Remove from both caches
        if (this.currentSessions) {
          this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
        }
        if (this.allSessions) {
          this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
        }
        const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
        const showCwd = this.scope === "all";
        this.sessionList.setSessions(sessions, showCwd);
        const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
        this.header.setStatusMessage({ type: "info", message: msg }, 2000);
        // Refresh sessions in background since the file is gone
        await this.refreshSessionsAfterMutation();
      } else {
        const errorMessage = result.error ?? "Unknown error";
        this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
      }
      this.tuiRequestRender();
    };
    this.sessionList.onRenameSession = (sessionPath) => {
      if (this.scope === "current" && this.currentLoading) return;
      if (this.scope === "all" && this.allLoading) return;
      const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
      const session = sessions.find((s) => s.path === sessionPath);
      this.enterRenameMode(sessionPath, session?.name);
    };

    // Build layout
    this.buildBaseLayout(this.sessionList);

    // Start loading current sessions (mark as loaded since we already have them)
    this.currentLoading = false;
    this.header.loading = false;

    // If we don't have all sessions yet, pre-load them in the background
    if (allSessions === null && allMetas.length > 0) {
      this.startAllLoadBackground();
    }
  }

  private enterRenameMode(sessionPath: string, currentName?: string): void {
    this.mode = "rename";
    this.renameTargetPath = sessionPath;
    this.renameInput.setValue(currentName ?? "");
    this.renameInput.focused = true;

    const panel = new Container();
    panel.addChild(new Text(this.theme.bold("Rename Session"), 1, 0));
    panel.addChild(new Spacer(1));
    panel.addChild(this.renameInput);
    panel.addChild(new Spacer(1));
    panel.addChild(new Text(
      this.theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
      1,
      0,
    ));

    this.buildBaseLayout(panel, { showHeader: false });
    this.tuiRequestRender();
  }

  private exitRenameMode(): void {
    this.mode = "list";
    this.renameTargetPath = null;
    this.buildBaseLayout(this.sessionList);
    this.tuiRequestRender();
  }

  private async confirmRename(value: string): Promise<void> {
    const next = value.trim();
    if (!next) return;
    const target = this.renameTargetPath;
    if (!target) {
      this.exitRenameMode();
      return;
    }

    try {
      const mgr = SessionManager.open(target);
      mgr.appendSessionInfo(next);
      await this.refreshSessionsAfterMutation();
    } finally {
      this.exitRenameMode();
    }
  }

  private rescanCurrentScope(): SessionHeader[] {
    if (!this.sessionDir) return [];
    const metas = sortByModifiedDesc(scanSessionDir(this.sessionDir));
    let headers = loadSessionHeaders(metas);
    if (!this.usesDefaultSessionDir) {
      headers = filterByCwd(headers, this.cwd);
    }
    return sortByModified(headers);
  }

  private rescanAllScope(): SessionHeader[] {
    if (this.usesDefaultSessionDir) {
      const metas = scanAllSessionDirs();
      const headers = loadSessionHeaders(metas);
      return sortByModified(headers);
    }
    if (!this.sessionDir) return [];
    const metas = sortByModifiedDesc(scanSessionDir(this.sessionDir));
    const headers = loadSessionHeaders(metas);
    return sortByModified(headers);
  }

  private async refreshSessionsAfterMutation(): Promise<void> {
    // Rescan from disk so renames, deletes, and newly created sessions are
    // reflected in the list. This mirrors upstream's loadScope(scope, "refresh").
    // Bump the sequence number first so any in-progress background all-load
    // stops before it can overwrite the rescanned data.
    this.allLoadSeq++;
    try {
      if (this.scope === "current") {
        this.currentSessions = this.rescanCurrentScope();
        this.sessionList.setSessions(this.currentSessions, false);
      } else {
        this.allLoading = true;
        this.allSessions = this.rescanAllScope();
        this.allLoading = false;
        this.sessionList.setSessions(this.allSessions, true);
      }
      this.header.loading = false;
      this.header.loadProgress = null;
    } catch (err) {
      this.currentLoading = false;
      this.allLoading = false;
      this.header.loading = false;
      this.header.loadProgress = null;
      const message = err instanceof Error ? err.message : String(err);
      this.header.setStatusMessage({ type: "error", message: `Failed to refresh: ${message}` }, 4000);
    }
  }

  private startAllLoadBackground(): void {
    this.allLoading = true;
    const seq = ++this.allLoadSeq;
    const BATCH_SIZE = 50;
    const sorted = sortByModifiedDesc([...this.allMetas]);
    let offset = 0;
    const allParsed: SessionHeader[] = [];

    const loadBatch = () => {
      if (seq !== this.allLoadSeq) return; // Stale
      if (this.loadingAbort?.signal.aborted) return;

      const batch = sorted.slice(offset, offset + BATCH_SIZE);
      if (batch.length === 0) {
        this.allLoading = false;
        this.allSessions = sortByModified(allParsed);

        // If we're currently showing "all" scope, update the list
        if (this.scope === "all") {
          this.header.loading = false;
          this.sessionList.setSessions(this.allSessions, true);
          this.tuiRequestRender();

          // Auto-dismiss if no sessions exist anywhere
          if (this.allSessions.length === 0 && (this.currentSessions?.length ?? 0) === 0) {
            this.done({ cancelled: true });
          }
        }
        return;
      }

      let headers: SessionHeader[];
      try {
        headers = loadSessionHeaders(batch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.allLoading = false;
        if (this.scope === "all") {
          this.header.loading = false;
          this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
          this.tuiRequestRender();
        }
        return;
      }

      allParsed.push(...headers);

      // If we're currently showing "all" scope, update progress
      if (this.scope === "all") {
        this.header.loadProgress = { loaded: allParsed.length, total: sorted.length };
        this.allSessions = sortByModified([...allParsed]);
        this.sessionList.setSessions(this.allSessions, true);
        this.tuiRequestRender();
      }

      offset += BATCH_SIZE;
      setImmediate(loadBatch);
    };

    setImmediate(loadBatch);
  }

  private toggleScope(): void {
    if (this.scope === "current") {
      this.scope = "all";
      this.header.scope = "all";

      if (this.allSessions !== null) {
        this.header.loading = false;
        this.sessionList.setSessions(this.allSessions, true);
      } else if (!this.allLoading) {
        // Start loading all sessions
        this.allLoading = true;
        this.header.loading = true;
        this.header.loadProgress = null;
        this.startAllLoadBackground();
      } else {
        this.header.loading = true;
      }
    } else {
      this.scope = "current";
      this.header.scope = "current";
      this.header.loading = false;
      this.sessionList.setSessions(this.currentSessions ?? [], false);
    }

    this.tuiRequestRender();
  }

  private toggleSortMode(): void {
    // Cycle: threaded → recent → relevance → threaded
    this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
    this.header.sortMode = this.sortMode;
    this.sessionList.setSortMode(this.sortMode);
    this.tuiRequestRender();
  }

  private toggleNameFilter(): void {
    this.nameFilter = this.nameFilter === "all" ? "named" : "all";
    this.header.nameFilter = this.nameFilter;
    this.sessionList.setNameFilter(this.nameFilter);
    this.tuiRequestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "rename") {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.cancel")) {
        this.exitRenameMode();
        return;
      }
      this.renameInput.handleInput(data);
      return;
    }
    this.sessionList.handleInput(data);
  }
}

async function showFastResumePicker(
  ctx: ExtensionCommandContext,
  initialQuery?: string,
): Promise<void> {
  const cwd = ctx.cwd;
  const sessionDir = ctx.sessionManager.getSessionDir();
  const usesDefaultSessionDir = getUsesDefaultSessionDir(ctx.sessionManager);

  const t0 = Date.now();

  // Load the current-scope sessions immediately, and collect metadata for the
  // incremental "all" scope load that happens in the background.
  const currentSessions = loadCurrentSessionsImmediate(cwd, sessionDir, usesDefaultSessionDir);
  const allMetas = loadAllSessionMetas(sessionDir, usesDefaultSessionDir);

  const loadTime = Date.now() - t0;

  ctx.ui.notify(
    `Fast resume: ${currentSessions.length} current, ${allMetas.length} total in ${loadTime}ms`,
    "info",
  );

  const result = await ctx.ui.custom<FastResumeResult>(
    (_tui, theme, _kb, done) => {
      const picker = new FastResumePicker(
        theme,
        cwd,
        sessionDir,
        usesDefaultSessionDir,
        ctx.sessionManager.getSessionFile(),
        currentSessions,
        allMetas,
        null, // allSessions not yet loaded — will load in background
        (result) => done(result),
        () => _tui.requestRender(),
        initialQuery,
      );

      return picker;
    },
  );

  if (result && result.sessionPath && !result.cancelled) {
    await ctx.switchSession(result.sessionPath);
  }
}

// Stored reference to the extension runner, captured via prototype patch on
// InteractiveMode.prototype.setupExtensionShortcuts. Used by the shortcut
// handler to create an ExtensionCommandContext with switchSession(), since
// pi.registerShortcut handlers only receive ExtensionContext.
let storedExtensionRunner: any = null;

// Reference to the original showSessionSelector, saved before patching
let origShowSessionSelector: ((this: InteractiveMode) => void) | null = null;

// Reference to the original setupExtensionShortcuts, saved before patching
let origSetupExtensionShortcuts: Function | null = null;

function patchSetupExtensionShortcuts(): void {
  if (origSetupExtensionShortcuts !== null) return; // Already patched
  const proto = InteractiveMode.prototype as any;
  if (
    !InteractiveMode ||
    typeof InteractiveMode !== "function" ||
    typeof proto.setupExtensionShortcuts !== "function"
  ) {
    return;
  }
  origSetupExtensionShortcuts = proto.setupExtensionShortcuts;
  proto.setupExtensionShortcuts = function (
    this: InteractiveMode,
    extensionRunner: any,
  ) {
    storedExtensionRunner = extensionRunner;
    origSetupExtensionShortcuts!.call(this, extensionRunner);
  };
}

function unpatchSetupExtensionShortcuts(): void {
  if (origSetupExtensionShortcuts === null) return;
  const proto = InteractiveMode.prototype as any;
  if (
    InteractiveMode &&
    typeof InteractiveMode === "function" &&
    typeof proto.setupExtensionShortcuts === "function"
  ) {
    proto.setupExtensionShortcuts = origSetupExtensionShortcuts;
  }
  origSetupExtensionShortcuts = null;
  storedExtensionRunner = null;
}

function installResumeHijack(): void {
  if (origShowSessionSelector !== null) return; // Already patched
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype patching requires any cast for private access
  const proto = InteractiveMode.prototype as any;
  if (
    !InteractiveMode ||
    typeof InteractiveMode !== "function" ||
    typeof proto.showSessionSelector !== "function"
  ) {
    return; // Guard: API changed or not available
  }
  origShowSessionSelector = proto.showSessionSelector;
  proto.showSessionSelector = function (this: InteractiveMode) {
    // Try to get an ExtensionCommandContext from the running session's extension runner
    const session = (this as any).session;
    if (!session?.extensionRunner?.createCommandContext) {
      // Fallback to original if we can't get a command context
      origShowSessionSelector!.call(this);
      return;
    }
    const ctx = session.extensionRunner.createCommandContext() as ExtensionCommandContext;
    // Fire-and-forget — same pattern as the original (synchronous, UI appears immediately)
    void showFastResumePicker(ctx);
  };
}

function uninstallResumeHijack(): void {
  if (origShowSessionSelector === null) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype patching requires any cast for private access
  const proto = InteractiveMode.prototype as any;
  if (
    InteractiveMode &&
    typeof InteractiveMode === "function" &&
    typeof proto.showSessionSelector === "function"
  ) {
    proto.showSessionSelector = origShowSessionSelector;
  }
  origShowSessionSelector = null;
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const hijackResume = config.hijackResume !== false;

  if (hijackResume) {
    // Hijack /resume — replace the built-in session selector with our fast picker
    installResumeHijack();
    // Don't register /fast-resume — /resume already opens the fast picker
  } else {
    // Normal mode — register /fast-resume as a standalone command
    pi.registerCommand("fast-resume", {
      description: "Fast session resume — instant picker with incremental loading",
      getArgumentCompletions: (prefix: string) => {
        if (!prefix) return null;
        return [{ value: prefix, label: `Search: ${prefix}` }];
      },
      handler: async (args, ctx) => {
        const query = args?.trim() || undefined;
        await showFastResumePicker(ctx, query);
      },
    });
  }

  // Register a standalone keyboard shortcut for the fast resume picker.
  // pi.registerShortcut handlers receive ExtensionContext (no switchSession),
  // so we capture the extension runner via a prototype patch on
  // InteractiveMode.prototype.setupExtensionShortcuts and use it to create
  // an ExtensionCommandContext inside the handler.
  //
  // Users can rebind the key via pi-fast-resume.json:
  //   { "shortcut": "alt+u" }
  //
  // In hijack mode, app.session.resume also opens the fast picker (rebindable
  // in ~/.pi/agent/keybindings.json). The shortcut config is an additional
  // independent binding that does not override the built-in /resume.
  const shortcut = config.shortcut;
  if (shortcut) {
    // Patch setupExtensionShortcuts so we can capture the extension runner.
    // This runs before setupExtensionShortcuts is called (during extension
    // load, which precedes the shortcut setup phase).
    patchSetupExtensionShortcuts();

    pi.registerShortcut(shortcut as KeyId, {
      description: "Fast session resume",
      handler: async (ctx) => {
        // Use the stored extension runner to get a full command context
        // with switchSession(), since the shortcut handler ctx (ExtensionContext)
        // does not include session-switching methods.
        if (
          !storedExtensionRunner ||
          typeof storedExtensionRunner.createCommandContext !== "function"
        ) {
          ctx.ui.notify(
            "Fast resume shortcut: extension runner not available. Try reloading with /reload.",
            "error",
          );
          return;
        }
        const cmdCtx =
          storedExtensionRunner.createCommandContext() as ExtensionCommandContext;
        await showFastResumePicker(cmdCtx);
      },
    });
  }

  // Clean up prototype patches on session shutdown (reload, quit, session switch)
  pi.on("session_shutdown", () => {
    if (hijackResume) {
      uninstallResumeHijack();
    }
    if (shortcut) {
      unpatchSetupExtensionShortcuts();
    }
  });
}
