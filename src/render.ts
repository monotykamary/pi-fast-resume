import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionHeader } from "./scanner.js";
import type { PickerScope } from "./picker-state.js";

const HOME = globalThis.process?.env?.HOME || "";

const MAX_VISIBLE = 10;
const MAX_MSG_WIDTH = 64;

export interface RenderOptions {
  scope: PickerScope;
  loadedCount: number;
  totalCount: number;
  loadingDone: boolean;
  filterQuery: string;
  showCwd: boolean;
  currentSessionPath?: string;
  now?: Date;
}

function relativeCwd(cwd: string): string {
  if (cwd.startsWith(HOME)) {
    return "~" + cwd.slice(HOME.length);
  }
  return cwd;
}

function formatAge(date: Date, now: Date): string {
  const ms = now.getTime() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function renderSessionList(
  sessions: SessionHeader[],
  selectedIndex: number,
  theme: Theme,
  options: RenderOptions,
  width: number,
): string[] {
  const lines: string[] = [];
  const now = options.now ?? new Date();

  if (sessions.length === 0) {
    if (options.scope === "current") {
      lines.push(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."));
    } else {
      lines.push(theme.fg("muted", "  No sessions found"));
    }
    return lines;
  }

  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE / 2),
      sessions.length - MAX_VISIBLE,
    ),
  );
  const endIndex = Math.min(startIndex + MAX_VISIBLE, sessions.length);

  for (let i = startIndex; i < endIndex; i++) {
    const session = sessions[i]!;
    const isSelected = i === selectedIndex;
    const isCurrent = session.path === options.currentSessionPath;
    const hasName = !!session.name;

    const displayText = (session.name || session.firstMessage || "(empty)")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim();

    // Right side: cwd (if all scope) + message count + age
    const rightParts: string[] = [];
    if (options.showCwd && session.cwd) {
      rightParts.push(relativeCwd(session.cwd));
    }
    rightParts.push(`${session.messageCount} msg${session.messageCount !== 1 ? "s" : ""}`);
    rightParts.push(formatAge(session.modified, now));
    const rightText = rightParts.join(" · ");

    // Cursor + message
    const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

    let messageColor: Parameters<Theme["fg"]>[0] | null = null;
    if (isCurrent) {
      messageColor = "accent";
    } else if (hasName) {
      messageColor = "warning";
    }

    const rightWidth = visibleWidth(rightText) + 2;
    const availableForMsg = Math.max(10, width - visibleWidth(cursor) - rightWidth);
    const truncatedMsg = truncateToWidth(displayText, availableForMsg, "…");
    const styledMsg = messageColor
      ? theme.fg(messageColor, truncatedMsg)
      : theme.fg("text", truncatedMsg);

    const leftPart = cursor + styledMsg;
    const leftWidth = visibleWidth(leftPart);
    const spacing = Math.max(1, width - leftWidth - visibleWidth(rightText));
    const styledRight = theme.fg("dim", rightText);

    let line = leftPart + " ".repeat(spacing) + styledRight;
    if (isSelected) {
      line = theme.bg("selectedBg", line);
    }
    lines.push(truncateToWidth(line, width));
  }

  // Scroll indicator
  if (startIndex > 0 || endIndex < sessions.length) {
    lines.push(
      theme.fg("muted", `  (${selectedIndex + 1}/${sessions.length})`),
    );
  }

  return lines;
}
