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
 *   Enter                 Select session
 *   Esc                   Cancel
 *   typing                Filter sessions by text search
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, Theme, keyHint, keyText } from "@earendil-works/pi-coding-agent";
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
import { homedir } from "node:os";
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

// Header — mirrors SessionSelectorHeader layout exactly:
// Line 1: Title (left) │ Scope indicators + loading progress (right)
// Line 2: Hint line 1 (scope toggle + search hints)
// Line 3: Hint line 2 (sort/delete/path — minimal for fast-resume)

class FastResumeHeader implements Component {
  private theme: Theme;
  scope: PickerScope = "current";
  loading = false;
  loadProgress: { loaded: number; total: number } | null = null;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;

    // Title (left side)
    const title = this.scope === "current"
      ? t.bold("Resume Session (Current Folder)")
      : t.bold("Resume Session (All)");

    // Scope indicators (right side)
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

    const rightText = truncateToWidth(scopeText, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
    const left = truncateToWidth(title, availableLeft, "");
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

    // Hint lines — same style as built-in selector
    const sep = t.fg("muted", " · ");
    const hint1 = keyHint("tui.input.tab", "scope") + sep + t.fg("muted", 're:<pattern> regex · "phrase" exact');
    const hint2 = keyHint("tui.select.confirm", "select") + sep + keyHint("tui.select.cancel", "cancel");

    return [
      `${left}${" ".repeat(spacing)}${rightText}`,
      truncateToWidth(hint1, width, "…"),
      truncateToWidth(hint2, width, "…"),
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
  maxVisible = 10;
  currentSessionPath: string | undefined;

  onSelect?: (sessionPath: string) => void;
  onCancel?: () => void;
  onToggleScope?: () => void;

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

  setSessions(sessions: SessionHeader[], showCwd: boolean): void {
    this.allSessions = sessions;
    this.showCwd = showCwd;
    this.filterSessions(this.searchInput.getValue());
  }

  filterSessions(query: string): void {
    const trimmed = query.trim();
    if (trimmed) {
      this.filteredSessions = fuzzyFilter(
        this.allSessions,
        trimmed,
        (s) => `${s.name ?? ""} ${s.firstMessage} ${s.cwd} ${s.id}`,
      );
    } else {
      this.filteredSessions = [...this.allSessions];
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
      if (this.showCwd) {
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
      const isCurrent = session.path === this.currentSessionPath;
      const hasName = !!session.name;

      // Session display text
      const displayText = (session.name ?? session.firstMessage ?? "(empty)")
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim();

      // Right side: cwd (if all scope) + message count + age
      const age = formatSessionDate(session.modified);
      const msgCount = String(session.messageCount);
      let rightPart = `${msgCount} ${age}`;
      if (this.showCwd && session.cwd) {
        rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
      }

      // Cursor
      const cursor = isSelected ? t.fg("accent", "› ") : "  ";

      // Calculate available width for message
      const rightWidth = visibleWidth(rightPart) + 2;
      const availableForMsg = width - 2 - rightWidth; // -2 for cursor
      const truncatedMsg = truncateToWidth(displayText, Math.max(10, availableForMsg), "…");

      // Style message — same color logic as built-in
      let messageColor: Parameters<Theme["fg"]>[0] | null = null;
      if (isCurrent) {
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
      const styledRight = t.fg("dim", rightPart);
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

    if (kb.matches(data, "tui.input.tab")) {
      this.onToggleScope?.();
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

class FastResumePicker extends Container {
  private header: FastResumeHeader;
  private sessionList: FastResumeSessionList;
  private theme: Theme;
  private tuiRequestRender: () => void;
  private done: (result: FastResumeResult) => void;

  private scope: PickerScope = "current";
  private currentSessions: SessionHeader[] | null = null;
  private allSessions: SessionHeader[] | null = null;
  private currentLoading = false;
  private allLoading = false;

  private allMetas: SessionFileMeta[] = [];
  private loadingAbort: AbortController | null = null;
  private allLoadSeq = 0;

  // Focusable — propagate to sessionList
  private _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.sessionList.focused = v;
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
    this.header = new FastResumeHeader(theme);

    // Create session list
    this.sessionList = new FastResumeSessionList(theme, currentSessionPath);
    this.currentSessions = initialCurrentSessions;
    this.allSessions = allSessions;

    // Set initial data into the list
    this.sessionList.setSessions(initialCurrentSessions, false);

    // Wire events
    this.sessionList.onSelect = (sessionPath) => {
      this.loadingAbort?.abort();
      this.done({ sessionPath, cancelled: false });
    };
    this.sessionList.onCancel = () => {
      this.loadingAbort?.abort();
      this.done({ cancelled: true });
    };
    this.sessionList.onToggleScope = () => this.toggleScope();

    // Build layout
    this.buildLayout();

    // Start loading current sessions (mark as loaded since we already have them)
    this.currentLoading = false;
    this.header.loading = false;

    // If we don't have all sessions yet, pre-load them in the background
    if (allSessions === null && allMetas.length > 0) {
      this.startAllLoadBackground();
    }
  }

  private buildLayout(): void {
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
    this.addChild(new Spacer(1));
    this.addChild(this.header);
    this.addChild(new Spacer(1));
    this.addChild(this.sessionList);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
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

  handleInput(data: string): void {
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
