// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import type { Runtime } from "../../runtime/index.ts";
import { alerts, button, click, settle, text, unmountAll } from "../../testing/dom.ts";
import { hasUnsavedFiles } from "../../stores/unsaved-files.ts";
import { entry } from "./files-bed.ts";
import {
  NAMES,
  ETAG_1,
  ETAG_3,
  diskOf,
  editor,
  open,
  resetWorld,
  save,
  show,
  tabNames,
  type,
  world,
  writeParams,
} from "./edit-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@pap/ui/code", async () => (await import("./editor-mock.ts")).mockCodeModule());

beforeEach(() => resetWorld((runtime) => (current.runtime = runtime)));
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editing across tabs", () => {
  describe("unsaved edits", () => {
    it("survive a switch of tab, with the base etag they were opened on", async () => {
      const c = await show();
      await open(c, "a.ts");
      await type(c, "draft");
      await open(c, "b.ts");
      expect(editor(c).value).toBe("disk b.ts");
      await click(c.querySelector('[role="tab"]') as HTMLElement);
      await settle();
      expect(editor(c).value).toBe("draft");
      await save(c);
      expect(writeParams()).toEqual({ path: "/p/a.ts", text: "draft", baseEtag: ETAG_1 });
    });

    it("meet the conflict banner at once when the file changed while another tab was shown", async () => {
      const c = await show();
      await open(c, "a.ts");
      await type(c, "draft");
      await open(c, "b.ts");
      Object.assign(diskOf("/p/a.ts"), { etag: ETAG_3, text: "theirs" });
      await click(c.querySelector('[role="tab"]') as HTMLElement);
      await settle();
      expect(text(c)).toContain("Changed on disk since you opened it");
      expect(editor(c).value).toBe("draft");
    });

    it("mark the tab, and closing it asks first", async () => {
      const c = await show();
      await open(c, "a.ts");
      await type(c, "draft");
      const close = c.querySelector('button[aria-label="Close a.ts (unsaved changes)"]') as HTMLElement;
      expect(close).not.toBeNull();
      await click(close);
      expect(text(c)).toContain("Discard your changes?");
      expect(tabNames(c)).toEqual(["a.ts"]);
      await click(button(c, "Cancel"));
      expect(tabNames(c)).toEqual(["a.ts"]);
      expect(editor(c).value).toBe("draft");
      await click(close);
      await click(button(c, "Discard"));
      expect(tabNames(c)).toEqual([]);
    });

    it("a clean tab closes without a question", async () => {
      const c = await show();
      await open(c, "a.ts");
      await click(c.querySelector('button[aria-label="Close a.ts"]') as HTMLElement);
      expect(text(c)).not.toContain("Discard your changes?");
      expect(tabNames(c)).toEqual([]);
    });

    it("tell the shell while the folder has unsaved edits, and stop when saved or closed", async () => {
      const c = await show();
      await open(c, "a.ts");
      expect(hasUnsavedFiles("/p")).toBe(false);
      await type(c, "draft");
      expect(hasUnsavedFiles("/p")).toBe(true);
      await save(c);
      expect(hasUnsavedFiles("/p")).toBe(false);
      await type(c, "again");
      expect(hasUnsavedFiles("/p")).toBe(true);
      await unmountAll();
      expect(hasUnsavedFiles("/p")).toBe(false);
    });

    it("arm the unload warning only while a tab is dirty", async () => {
      const c = await show();
      const unload = () => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      await open(c, "a.ts");
      expect(unload()).toBe(false);
      await type(c, "draft");
      expect(unload()).toBe(true);
      await save(c);
      expect(unload()).toBe(false);
    });

    it("with eight dirty tabs a ninth file is not opened and the pane says why", async () => {
      const c = await show();
      for (const name of NAMES.filter((one) => one.endsWith(".ts"))) {
        await open(c, name);
        await type(c, `edit ${name}`);
      }
      await open(c, "c.md");
      expect(tabNames(c)).toHaveLength(8);
      expect(text(c)).toContain("Eight files are open and all have unsaved changes.");
      expect(alerts(c).join(" ")).toContain("Eight files are open");
    });
  });

  describe("window focus", () => {
    const refocus = async () => {
      window.dispatchEvent(new Event("focus"));
      await settle();
    };

    it("reloads a clean file whose mtime moved", async () => {
      const c = await show();
      await open(c, "a.ts");
      Object.assign(diskOf("/p/a.ts"), { mtimeMs: 300, text: "newer", etag: ETAG_3 });
      await refocus();
      expect(editor(c).value).toBe("newer");
    });

    it("leaves a clean file alone when nothing moved", async () => {
      const c = await show();
      await open(c, "a.ts");
      await refocus();
      expect(editor(c).value).toBe("disk a.ts");
    });

    it("shows the conflict banner on a dirty file whose content changed, and keeps the edit", async () => {
      const c = await show();
      await open(c, "a.ts");
      await type(c, "draft");
      Object.assign(diskOf("/p/a.ts"), { mtimeMs: 300, text: "newer", etag: ETAG_3 });
      await refocus();
      expect(text(c)).toContain("Changed on disk since you opened it");
      expect(editor(c).value).toBe("draft");
    });
  });

  describe("per tab view", () => {
    it("keeps Preview or Source of each Markdown tab across switches", async () => {
      const c = await show();
      await open(c, "c.md");
      await click(button(c, "Source"));
      expect(editor(c)).not.toBeNull();
      await open(c, "d.md");
      expect(c.querySelector('[data-slot="code-editor"]')).toBeNull();
      await click(c.querySelectorAll('[role="tab"]')[0] as HTMLElement);
      await settle();
      expect(editor(c).value).toBe("disk c.md");
    });

    it("titles same-named files apart", async () => {
      world.disk.set("/p/sub/a.ts", { text: "x", etag: ETAG_1, mtimeMs: 1, patch: {} });
      world.bed.handlers["files.list"] = (params) => ({
        entries:
          (params as { path: string }).path === "/p"
            ? [entry("a.ts"), { ...entry("sub"), kind: "dir" as const }]
            : [entry("a.ts")],
        truncated: false,
      });
      const c = await show();
      await open(c, "a.ts");
      await click(c.querySelector('[role="treeitem"][data-path="/p/sub"]') as HTMLElement);
      await settle();
      await open(c, "sub/a.ts");
      expect(tabNames(c)).toEqual(["a.ts (p)", "a.ts (sub)"]);
    });
  });
});
