import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../fast-resume.js";

const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", hostEntry).href);
const hostTheme = await import(new URL("./modes/interactive/theme/theme.js", hostEntry).href);
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Exercise the real picker through its existing host entrypoint, using only
// synthetic session files. No private-class exports or provider calls needed.
async function withPicker(run: (picker: any, dir: string) => Promise<void>, childrenOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "parent-filter-"));
  tempDirs.push(dir);
  const add = (id: string, parentSession?: string, name?: string, cwd = "/project") => {
    const entries: any[] = [{ type: "session", id, timestamp: "2026-01-01T00:00:00Z", cwd, parentSession }];
    if (name) entries.push({ type: "session_info", name });
    entries.push({ type: "message", message: { role: "user", content: `${id} task` } });
    writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  };
  if (!childrenOnly) {
    add("root", undefined, "Root work");
    add("standalone");
    add("otherroot", undefined, "Other work", "/other");
  }
  add("child", join(dir, "root.jsonl"), "Child work");
  add("grandchild", join(dir, "child.jsonl"));
  add("orphan", join(dir, "missing.jsonl"));
  add("crossscopechild", join(dir, "otherroot.jsonl"));
  const handlers = new Map<string, any>();
  extension({ on: (n: string, fn: any) => handlers.set(n, fn), registerCommand() {}, registerShortcut() {} } as any);
  initTheme("dark", false);
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager());
  const ctx: any = {
    mode: "tui", cwd: "/project", hasUI: true,
    sessionManager: { getSessionDir: () => dir, usesDefaultSessionDir: () => false, getSessionFile: () => undefined },
    switchSession() {},
    ui: { notify(message: string, level: string) { if (level === "error" || level === "warning") throw new Error(message); }, custom: async (create: any) => {
      const picker = create({ requestRender() {} }, hostTheme.theme, {}, () => {});
      try { await run(picker, dir); }
      finally { picker.handleInput("\x1b"); await tick(); await tick(); }
      return { cancelled: true };
    } },
  };
  try {
    handlers.get("session_start")({}, ctx);
    await (InteractiveMode.prototype as any).showSessionSelector.call({ session: { extensionRunner: { createCommandContext: () => ctx } } });
  } finally { handlers.get("session_shutdown")({}, ctx); setKeybindings(previousBindings); }
}

const ids = (picker: any): string[] => picker.sessionList.filteredNodes.map((n: any) => n.session.id).sort();
const input = (picker: any, query: string) => { picker.sessionList.searchInput.setValue(query); picker.sessionList.filterSessions(query); };

describe("parent-only picker shortcut", () => {
  it("toggles real header ancestry, composes with filters/sorts/scopes, and restores children", async () => {
    await withPicker(async picker => {
      expect(ids(picker)).toEqual(["child", "crossscopechild", "grandchild", "orphan", "root", "standalone"]);
      expect(picker.render(120).join("\n")).toContain("parents only (off)");
      picker.handleInput("\x0f"); // Ctrl+O
      expect(ids(picker)).toEqual(["root", "standalone"]);
      expect(picker.render(120).join("\n")).toContain("parents only (on)");
      for (const width of [30, 80, 120]) for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      for (let i = 0; i < 3; i++) {
        picker.handleInput("\x13"); // Ctrl+S
        expect(ids(picker)).toEqual(["root", "standalone"]);
      }
      picker.handleInput("\x0e"); // Ctrl+N
      expect(ids(picker)).toEqual(["root"]);
      input(picker, "re:child");
      expect(ids(picker)).toEqual([]);
      picker.handleInput("\x0f");
      expect(ids(picker)).toEqual(["child"]);
      picker.handleInput("\x0f");
      input(picker, '"Root work"');
      expect(ids(picker)).toEqual(["root"]);
      input(picker, "");
      picker.handleInput("\x0e");
      // All-scope loading remains filtered, including the parent that was
      // outside the current cwd. Header ancestry does not depend on scope.
      picker.handleInput("\t");
      for (let i = 0; i < 10 && picker.allLoading; i++) await tick();
      expect(ids(picker)).toEqual(["otherroot", "root", "standalone"]);
      picker.handleInput("\x0f");
      expect(ids(picker)).toContain("grandchild");
      expect(ids(picker)).toContain("orphan");
    });
    await withPicker(async picker => { expect(picker.sessionList.parentsOnly).toBe(false); });
  });

  it("preserves a selected root and does not toggle in delete confirmation or rename input", async () => {
    await withPicker(async picker => {
      const list = picker.sessionList;
      list.selectedIndex = list.filteredNodes.findIndex((n: any) => n.session.id === "standalone");
      const selected = list.getSelectedSessionPath();
      picker.handleInput("\x0f");
      expect(list.getSelectedSessionPath()).toBe(selected);
      picker.handleInput("\x04"); // Ctrl+D
      picker.handleInput("\x0f");
      expect(list.parentsOnly).toBe(true);
      picker.handleInput("\x1b"); // dismiss confirmation, not picker
      picker.handleInput("\x12"); // Ctrl+R
      picker.handleInput("\x0f");
      expect(list.parentsOnly).toBe(true);
      picker.handleInput("\x1b"); // dismiss rename
      picker.handleInput("\x0f");
      expect(list.parentsOnly).toBe(false);
      expect(list.getSelectedSessionPath()).toBe(selected);
      list.selectedIndex = list.filteredNodes.findIndex((n: any) => n.session.id === "child");
      picker.handleInput("\x0f");
      expect(list.getSelectedSessionPath()).not.toContain("/child.jsonl");
      expect(ids(picker)).toEqual(["root", "standalone"]);
    });
  });

  it("shows a useful empty state when all sessions are children", async () => {
    await withPicker(async picker => {
      picker.handleInput("\x0f");
      expect(ids(picker)).toEqual([]);
      expect(picker.render(120).join("\n")).toContain("No matching parent threads");
      picker.handleInput("\x0f");
      expect(ids(picker)).toHaveLength(4);
    }, true);
  });
});
