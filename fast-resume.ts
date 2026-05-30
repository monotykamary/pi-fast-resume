/**
 * pi-fast-resume — Fast session picker for pi
 *
 * Reads only the first 16KB of each session file (header + first messages)
 * instead of parsing the entire JSONL. Shows results instantly with
 * incremental background loading.
 *
 * Usage:
 *   /fr [query]        Open fast session picker (current project scope)
 *   Ctrl+Shift+F       Open fast session picker via shortcut
 *
 * Keys in picker:
 *   ↑/↓                Navigate
 *   Tab                Toggle scope (current project / all sessions)
 *   Enter              Select session
 *   Esc                Cancel
 *   typing             Filter sessions by fuzzy search
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Theme, keyText } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
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
import {
  type PickerScope,
} from "./src/picker-state.js";
import { renderSessionList } from "./src/render.js";

const HOME = homedir();

export interface FastResumeResult {
  sessionPath?: string;
  cancelled: boolean;
}

class FastResumePicker implements Component {
  private theme: Theme;
  private done: (result: FastResumeResult) => void;
  private tuiRequestRender: () => void;

  // Session data
  private allMetas: SessionFileMeta[] = [];
  private currentCwd: string;
  private currentSessionPath: string | undefined;
  private scope: PickerScope = "current";

  // Parsed session state
  private allSessions: SessionHeader[] = [];
  private filteredSessions: SessionHeader[] = [];
  private selectedIndex = 0;

  // Search
  private searchInput: Input;

  // Loading state
  private loadingAbort: AbortController | null = null;
  private loadingDone = false;
  private loadedCount = 0;
  private totalCount = 0;

  // Focusable — propagate to searchInput for IME cursor positioning
  private _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.searchInput.focused = v;
  }

  constructor(
    theme: Theme,
    currentCwd: string,
    currentSessionPath: string | undefined,
    initialSessions: SessionHeader[],
    allMetas: SessionFileMeta[],
    totalCount: number,
    loadingDone: boolean,
    done: (result: FastResumeResult) => void,
    tuiRequestRender: () => void,
  ) {
    this.theme = theme;
    this.currentCwd = currentCwd;
    this.currentSessionPath = currentSessionPath;
    this.done = done;
    this.tuiRequestRender = tuiRequestRender;

    this.allMetas = allMetas;
    this.totalCount = totalCount;
    this.loadingDone = loadingDone;
    this.loadedCount = initialSessions.length;

    this.allSessions = initialSessions;
    this.filteredSessions = initialSessions;

    this.searchInput = new Input();

    // Enter in search selects current item
    this.searchInput.onSubmit = () => {
      this.selectCurrent();
    };

    // Start background loading if there are more sessions
    if (!loadingDone && allMetas.length > 0) {
      this.startBackgroundLoad(allMetas, initialSessions.length);
    }
  }

  private startBackgroundLoad(
    metas: SessionFileMeta[],
    skipFirst: number,
  ): void {
    this.loadingAbort = new AbortController();
    const signal = this.loadingAbort.signal;

    const BATCH_SIZE = 50;
    const sorted = sortByModifiedDesc([...metas]);
    let offset = skipFirst;

    const loadBatch = () => {
      if (signal.aborted) return;

      const batch = sorted.slice(offset, offset + BATCH_SIZE);
      if (batch.length === 0) {
        this.loadingDone = true;
        this.tuiRequestRender();
        return;
      }

      const headers = loadSessionHeaders(batch);
      this.allSessions = sortByModified([...this.allSessions, ...headers]);
      this.applyFilter();

      this.loadedCount = this.allSessions.length;
      this.tuiRequestRender();

      offset += BATCH_SIZE;
      setImmediate(loadBatch);
    };

    setImmediate(loadBatch);
  }

  private applyFilter(): void {
    const query = this.searchInput.getValue().trim();
    const pool = this.scope === "current"
      ? filterByCwd(this.allSessions, this.currentCwd)
      : this.allSessions;

    if (query) {
      this.filteredSessions = fuzzyFilter(
        pool,
        query,
        (s) => `${s.name ?? ""} ${s.firstMessage} ${s.cwd} ${s.id}`,
      );
    } else {
      this.filteredSessions = pool;
    }

    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredSessions.length - 1),
    );
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.cancel")) {
      this.loadingAbort?.abort();
      this.done({ cancelled: true });
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }

    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.tuiRequestRender();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
      this.tuiRequestRender();
      return;
    }

    if (kb.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 10);
      this.tuiRequestRender();
      return;
    }

    if (kb.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 10);
      this.tuiRequestRender();
      return;
    }

    if (kb.matches(data, "tui.input.tab")) {
      this.toggleScope();
      return;
    }

    // Forward everything else to search input
    this.searchInput.handleInput(data);
    this.applyFilter();
    this.tuiRequestRender();
  }

  private selectCurrent(): void {
    this.loadingAbort?.abort();
    const selected = this.filteredSessions[this.selectedIndex];
    this.done({
      sessionPath: selected?.path,
      cancelled: false,
    });
  }

  private toggleScope(): void {
    this.loadingAbort?.abort();
    const newScope: PickerScope = this.scope === "current" ? "all" : "current";
    this.scope = newScope;

    if (newScope === "current") {
      this.applyFilter();
      this.loadingDone = true;
    } else {
      this.applyFilter();
      if (!this.loadingDone && this.allMetas.length > 0) {
        this.startBackgroundLoad(this.allMetas, this.loadedCount);
      }
    }

    this.tuiRequestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─".repeat(width);
    const border = this.theme.fg("borderAccent", borderChar);

    // Top border
    lines.push(border);
    lines.push("");

    // Title line — Fast Resume │ scope │ status
    const title = this.theme.fg("accent", this.theme.bold("Fast Resume"));
    const scopeLabel = this.scope === "current" ? "Current project" : "All sessions";
    const statusText = this.loadingDone
      ? `${this.filteredSessions.length} session${this.filteredSessions.length !== 1 ? "s" : ""}`
      : `Loading ${this.loadedCount}/${this.totalCount}…`;

    lines.push(
      title
        + "  " + this.theme.fg("dim", "│")
        + "  " + this.theme.fg("muted", scopeLabel)
        + "  " + this.theme.fg("dim", "│")
        + "  " + this.theme.fg("muted", statusText),
    );
    lines.push("");

    // Search input
    lines.push(...this.searchInput.render(width));
    lines.push("");

    // Session list
    lines.push(...renderSessionList(
      this.filteredSessions,
      this.selectedIndex,
      this.theme,
      {
        scope: this.scope,
        loadedCount: this.loadedCount,
        totalCount: this.totalCount,
        loadingDone: this.loadingDone,
        filterQuery: this.searchInput.getValue(),
        showCwd: this.scope === "all",
        currentSessionPath: this.currentSessionPath,
      },
      width,
    ));

    lines.push("");

    // Bottom border
    lines.push(border);

    // Footer key hints
    const footerParts = [
      `${keyText("tui.select.up")} ${keyText("tui.select.down")} navigate`,
      `${keyText("tui.select.confirm")} select`,
      `${keyText("tui.select.cancel")} cancel`,
      `Tab ${this.scope === "current" ? "all" : "project"}`,
    ];
    lines.push(this.theme.fg("dim", "  " + footerParts.join(" · ")));

    return lines;
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
  // "current" scope reads from the cwd-specific session dir
  // "all" scope reads from ALL session directories (like pi's listAll)
  const currentMetas = sessionDir ? scanSessionDir(sessionDir) : [];
  const allMetas = scanAllSessionDirs();

  // Phase 2: quickly parse the first 30 for instant display
  const INITIAL_BATCH = 30;
  const sortedCurrent = sortByModifiedDesc(currentMetas);
  const quickMetas = sortedCurrent.slice(0, INITIAL_BATCH);
  const quickHeaders = loadSessionHeaders(quickMetas);
  const initialSessions = sortByModified(quickHeaders);

  const loadTime = Date.now() - t0;

  ctx.ui.notify(
    `Fast resume: ${initialSessions.length} current, ${allMetas.length} total in ${loadTime}ms`,
    "info",
  );

  const result = await ctx.ui.custom<FastResumeResult>(
    (_tui, theme, _kb, done) => {
      const picker = new FastResumePicker(
        theme,
        cwd,
        ctx.sessionManager.getSessionFile(),
        initialSessions,
        allMetas,
        allMetas.length,
        quickMetas.length >= sortedCurrent.length,
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
  pi.registerCommand("fr", {
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
