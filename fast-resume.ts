/**
 * pi-fast-resume — Fast session picker for pi
 *
 * Reads only the first 16KB of each session file (header + first messages)
 * instead of parsing the entire JSONL. Shows results instantly with
 * incremental background loading.
 *
 * Mirrors the exact TUI layout and keybindings of pi's built-in /resume.
 *
 * Usage:
 *   /fast-resume [query]   Open fast session picker (current project scope)
 *   Ctrl+Shift+F           Open fast session picker via shortcut
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
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  keyHint,
  keyText,
  SessionManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  scanAllSessionDirs,
  scanSessionDir,
  loadSessionHeaders,
  sortByModified,
  sortByModifiedDesc,
  filterByCwd,
  type SessionHeader,
  type SessionFileMeta,
} from "./src/scanner.js";
import type { PickerScope } from "./src/picker-state.js";

const HOME = homedir();

export interface FastResumeResult {
  sessionPath?: string;
  cancelled: boolean;
}

type SortMode = "threaded" | "recent" | "fuzzy";
type NameFilter = "all" | "named";
type StatusMessage = { type: "info" | "error"; message: string };

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

function hasSessionName(session: SessionHeader): boolean {
  return Boolean(session.name?.trim());
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

// Session list — mirrors SessionList rendering exactly:
// search input + blank line + session rows (one line each, right-aligned metadata)

class FastResumeSessionList implements Component {
  private theme: Theme;
  allSessions: SessionHeader[] = [];
  filteredSessions: SessionHeader[] = [];
  selectedIndex = 0;
  searchInput: Input;
  showCwd = false;
  showPath = false;
  sortMode: SortMode = "threaded";
  nameFilter: NameFilter = "all";
  confirmingDeletePath: string | null = null;
  maxVisible = 10;
  currentSessionPath: string | undefined;

  onSelect?: (sessionPath: string) => void;
  onCancel?: () => void;
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

  constructor(theme: Theme, currentSessionPath: string | undefined) {
    this.theme = theme;
    this.currentSessionPath = currentSessionPath;
    this.searchInput = new Input();

    this.searchInput.onSubmit = () => {
      if (this.filteredSessions[this.selectedIndex]) {
        this.onSelect?.(this.filteredSessions[this.selectedIndex]!.path);
      }
    };
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
    const selected = this.filteredSessions[this.selectedIndex];
    if (!selected) return;
    if (selected.path === this.currentSessionPath) {
      this.onError?.("Cannot delete the currently active session");
      return;
    }
    this.setConfirmingDeletePath(selected.path);
  }

  private applyNameFilter(sessions: SessionHeader[]): SessionHeader[] {
    if (this.nameFilter === "all") return sessions;
    return sessions.filter(hasSessionName);
  }

  filterSessions(query: string): void {
    const nameFiltered = this.applyNameFilter(this.allSessions);
    const trimmed = query.trim();

    if (trimmed) {
      // With a query, fuzzyFilter handles relevance scoring
      this.filteredSessions = fuzzyFilter(
        nameFiltered,
        trimmed,
        (s) => `${s.name ?? ""} ${s.firstMessage} ${s.cwd} ${s.id}`,
      );
    } else {
      // No query: respect sort mode
      // "threaded" and "recent" both keep mtime order (descending)
      // "fuzzy" also keeps mtime order (no query to score by)
      this.filteredSessions = [...nameFiltered];
    }

    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredSessions.length - 1),
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

    if (this.filteredSessions.length === 0) {
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
        this.filteredSessions.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

    for (let i = startIndex; i < endIndex; i++) {
      const session = this.filteredSessions[i]!;
      const isSelected = i === this.selectedIndex;
      const isConfirmingDelete = session.path === this.confirmingDeletePath;
      const isCurrent = session.path === this.currentSessionPath;
      const hasName = !!session.name;

      // Session display text
      const displayText = (session.name ?? session.firstMessage ?? "(empty)")
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
      const rightWidth = visibleWidth(rightPart) + 2;
      const availableForMsg = width - 2 - rightWidth; // -2 for cursor
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
      const leftPart = cursor + styledMsg;
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
    if (startIndex > 0 || endIndex < this.filteredSessions.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
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
      const selected = this.filteredSessions[this.selectedIndex];
      if (selected) {
        this.onRenameSession?.(selected.path);
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
      this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
    } else if (kb.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
    } else if (kb.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
    } else if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.filteredSessions[this.selectedIndex];
      if (selected && this.onSelect) {
        this.onSelect(selected.path);
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
    currentSessionPath: string | undefined,
    initialCurrentSessions: SessionHeader[],
    allMetas: SessionFileMeta[],
    allSessions: SessionHeader[] | null,
    done: (result: FastResumeResult) => void,
    tuiRequestRender: () => void,
  ) {
    super();
    this.theme = theme;
    this.done = done;
    this.tuiRequestRender = tuiRequestRender;
    this.allMetas = allMetas;

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

  private async refreshSessionsAfterMutation(): Promise<void> {
    // After delete/rename, the in-memory arrays are already updated (filtered above).
    // Just re-apply them to the session list.
    const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
    const showCwd = this.scope === "all";
    this.sessionList.setSessions(sessions, showCwd);
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
        }
        return;
      }

      const headers = loadSessionHeaders(batch);
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
    this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "fuzzy" : "threaded";
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

  const t0 = Date.now();

  // Phase 1: stat all session files
  const currentMetas = sessionDir ? scanSessionDir(sessionDir) : [];
  const allMetas = scanAllSessionDirs();

  // Phase 2: quickly parse the first 30 for instant display
  const INITIAL_BATCH = 30;
  const sortedCurrent = sortByModifiedDesc(currentMetas);
  const quickMetas = sortedCurrent.slice(0, INITIAL_BATCH);
  const quickHeaders = loadSessionHeaders(quickMetas);
  const currentSessions = sortByModified(quickHeaders);

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
        ctx.sessionManager.getSessionFile(),
        currentSessions,
        allMetas,
        null, // allSessions not yet loaded — will load in background
        (result) => done(result),
        () => _tui.requestRender(),
      );

      return picker;
    },
  );

  if (result && result.sessionPath && !result.cancelled) {
    await ctx.switchSession(result.sessionPath);
  }
}

export default function (pi: ExtensionAPI) {
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

  pi.registerShortcut(Key.ctrlShift("f"), {
    description: "Open fast session resume picker",
    handler: async (ctx) => {
      await showFastResumePicker(ctx as unknown as ExtensionCommandContext);
    },
  });
}
