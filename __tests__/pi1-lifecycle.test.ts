import { describe, expect, it } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import extension from "../fast-resume.js";
import { installInteractivePatch } from "../src/interactive-patch.js";

describe("Pi 1.0 picker patch lifecycle", () => {
  it("patches only a live TUI and reinstalls after session replacement", () => {
    const handlers = new Map<string, any>();
    const proto = InteractiveMode.prototype as any;
    const original = proto.showSessionSelector;
    expect(typeof original).toBe("function");
    expect(typeof proto.setupExtensionShortcuts).toBe("function");
    extension({ on: (n: string, f: any) => handlers.set(n, f), registerCommand() {}, registerShortcut() {} } as any);
    expect(proto.showSessionSelector).toBe(original);
    const ctx = { mode: "tui", ui: { notify(message: string) { throw new Error(message); } } };
    try {
      handlers.get("session_start")({}, { ...ctx, mode: "sdk" });
      expect(proto.showSessionSelector).toBe(original);
      for (let i = 0; i < 2; i++) {
        handlers.get("session_start")({}, ctx);
        expect(proto.showSessionSelector).not.toBe(original);
        const installed = proto.showSessionSelector;
        handlers.get("session_start")({}, ctx);
        expect(proto.showSessionSelector).toBe(installed);
        handlers.get("session_shutdown")({}, ctx);
        expect(proto.showSessionSelector).toBe(original);
      }
    } finally { handlers.get("session_shutdown")({}, ctx); }
  });
  it.each([false, true])("unwinds overlapping shortcut wrappers in either order (%s)", reverse => {
    const calls: string[] = [];
    const original = function (this: any, arg: string) { calls.push(this.name + arg); return 7; };
    const target = { name: "host", method: original };
    const first = installInteractivePatch(target, "method", function (base, ...args) { calls.push("first"); return base.apply(this, args); });
    const second = installInteractivePatch(target, "method", function (base, ...args) { calls.push("second"); return base.apply(this, args); });
    expect(target.method("!")).toBe(7);
    expect(calls).toEqual(["second", "first", "host!"]);
    (reverse ? second : first)(); calls.length = 0;
    expect(target.method("?")).toBe(7);
    expect(calls).toEqual([reverse ? "first" : "second", "host?"]);
    (reverse ? first : second)();
    expect(target.method).toBe(original);
  });
});
