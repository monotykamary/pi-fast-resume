import type { SessionHeader } from "./scanner.js";

export type PickerScope = "current" | "all";

export interface PickerState {
  scope: PickerScope;
  sessions: SessionHeader[];
  filteredSessions: SessionHeader[];
  selectedIndex: number;
  filterQuery: string;
  loadingDone: boolean;
  loadedCount: number;
  totalCount: number;
}

export function createInitialState(
  initialSessions: SessionHeader[],
  totalCount: number,
  loadingDone: boolean,
): PickerState {
  return {
    scope: "current",
    sessions: initialSessions,
    filteredSessions: initialSessions,
    selectedIndex: 0,
    filterQuery: "",
    loadingDone,
    loadedCount: initialSessions.length,
    totalCount,
  };
}

export function setScope(state: PickerState, scope: PickerScope): PickerState {
  return {
    ...state,
    scope,
    filterQuery: "",
    selectedIndex: 0,
  };
}

export function setSessions(
  state: PickerState,
  sessions: SessionHeader[],
  loadingDone: boolean,
): PickerState {
  const filtered = applyFilter(sessions, state.filterQuery);
  return {
    ...state,
    sessions,
    filteredSessions: filtered,
    loadingDone,
    loadedCount: sessions.length,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, filtered.length - 1)),
  };
}

export function setFilter(
  state: PickerState,
  query: string,
): PickerState {
  const filtered = applyFilter(state.sessions, query);
  return {
    ...state,
    filterQuery: query,
    filteredSessions: filtered,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, filtered.length - 1)),
  };
}

export function moveSelection(
  state: PickerState,
  delta: number,
): PickerState {
  const max = Math.max(0, state.filteredSessions.length - 1);
  return {
    ...state,
    selectedIndex: Math.max(0, Math.min(max, state.selectedIndex + delta)),
  };
}

function applyFilter(
  sessions: SessionHeader[],
  query: string,
): SessionHeader[] {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(
    (s) =>
      s.firstMessage.toLowerCase().includes(q) ||
      (s.name?.toLowerCase().includes(q) ?? false) ||
      s.cwd.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q),
  );
}
