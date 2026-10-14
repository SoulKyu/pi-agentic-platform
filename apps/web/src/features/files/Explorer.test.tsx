// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { click, mount, press, settle, unmountAll } from "../../testing/dom.ts";
import { vcsStatus } from "../../testing/m8-fixtures.ts";
import { Explorer } from "./Explorer.tsx";
import { dirEntry, entry, filesBed } from "./files-bed.ts";
import { resetFolderMemory } from "./folder-memory.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const TREE = {
  "/p": [dirEntry("src"), dirEntry("secrets", { protected: true }), entry("README.md")],
  "/p/src": [dirEntry("deep"), entry("main.ts")],
  "/p/src/deep": [entry("leaf.ts")],
};

let bed: ReturnType<typeof filesBed>;
beforeEach(() => {
  localStorage.clear();
  resetFolderMemory();
  useVcsStore.getState().reset();
  bed = filesBed(TREE);
  current.runtime = bed.runtime;
});

async function show(onOpen: (path: string) => void = () => {}, selected: string | null = null) {
  const page = await mount(
    <TooltipProvider>
      <Explorer root="/p" selected={selected} onOpen={onOpen} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const row = (c: HTMLElement, path: string) => {
  const found = rows(c).find((item) => item.dataset.path === path);
  if (!found) throw new Error(`no row ${path}`);
  return found;
};
const listed = () =>
  bed.called("files.list").map((call) => (call.params as { path: string; showIgnored?: boolean }).path);

describe("Explorer", () => {
  it("lists the root on mount, and a folder's children once when it expands", async () => {
    const c = await show();
    expect(rows(c).map((item) => item.dataset.path)).toEqual(["/p/src", "/p/secrets", "/p/README.md"]);
    expect(listed()).toEqual(["/p"]);
    await click(row(c, "/p/src"));
    await settle();
    expect(listed()).toEqual(["/p", "/p/src"]);
    expect(rows(c).map((item) => item.dataset.path)).toEqual([
      "/p/src",
      "/p/src/deep",
      "/p/src/main.ts",
      "/p/secrets",
      "/p/README.md",
    ]);
    expect(row(c, "/p/src").getAttribute("aria-expanded")).toBe("true");
    await click(row(c, "/p/src"));
    await click(row(c, "/p/src"));
    await settle();
    expect(listed()).toEqual(["/p", "/p/src"]);
  });

  it("opens a file on click and marks the selected row with aria-selected and aria-current", async () => {
    const onOpen = vi.fn();
    const c = await show(onOpen, "/p/README.md");
    await click(row(c, "/p/README.md"));
    expect(onOpen).toHaveBeenCalledWith("/p/README.md");
    const selected = row(c, "/p/README.md");
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(row(c, "/p/src").getAttribute("aria-selected")).toBe("false");
    expect(row(c, "/p/src").hasAttribute("aria-current")).toBe(false);
  });

  it("a protected row shows a lock, has no aria-expanded and does not list when clicked", async () => {
    const c = await show();
    const locked = row(c, "/p/secrets");
    expect(locked.hasAttribute("aria-expanded")).toBe(false);
    expect(locked.querySelector('[data-slot="lock"]')?.getAttribute("aria-label")).toBe(
      "Protected: pap's data, Pi's configuration or a file hidden from this access",
    );
    await click(locked);
    await settle();
    expect(listed()).toEqual(["/p"]);
  });

  it("ArrowRight expands, ArrowLeft collapses, ArrowDown and ArrowUp move, Home and End jump", async () => {
    const c = await show();
    const tree = c.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    const src = row(c, "/p/src");
    await act(async () => src.focus());
    await press(src, { key: "ArrowRight" });
    await settle();
    expect(row(c, "/p/src").getAttribute("aria-expanded")).toBe("true");
    await press(row(c, "/p/src"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(c, "/p/src/deep"));
    await press(row(c, "/p/src/deep"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(c, "/p/src"));
    await press(row(c, "/p/src"), { key: "ArrowLeft" });
    expect(row(c, "/p/src").getAttribute("aria-expanded")).toBe("false");
    await press(row(c, "/p/src"), { key: "End" });
    expect(document.activeElement).toBe(row(c, "/p/README.md"));
    await press(row(c, "/p/README.md"), { key: "Home" });
    expect(document.activeElement).toBe(row(c, "/p/src"));
    await press(row(c, "/p/src"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row(c, "/p/src"));
  });

  it("Enter opens the focused file", async () => {
    const onOpen = vi.fn();
    const c = await show(onOpen);
    const readme = row(c, "/p/README.md");
    await act(async () => readme.focus());
    await press(readme, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/p/README.md");
  });

  it("lists the open folders again when the vcs status moves, on window focus and on Refresh", async () => {
    const c = await show();
    await click(row(c, "/p/src"));
    await settle();
    expect(listed()).toEqual(["/p", "/p/src"]);
    await act(async () =>
      useVcsStore.getState().apply("/p", { kind: "snapshot", status: vcsStatus("/p", { at: 1 }) }),
    );
    await settle();
    expect(listed()).toEqual(["/p", "/p/src"]);
    await act(async () =>
      useVcsStore.getState().apply("/p", { kind: "status", status: vcsStatus("/p", { at: 2 }) }),
    );
    await settle();
    expect(listed()).toEqual(["/p", "/p/src", "/p", "/p/src"]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(listed()).toHaveLength(6);
    const refresh = c.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    expect(refresh).not.toBeNull();
    await click(refresh as HTMLElement);
    await settle();
    expect(listed()).toHaveLength(8);
  });

  it("an unchanged status does not list again", async () => {
    await show();
    await act(async () =>
      useVcsStore.getState().apply("/p", { kind: "snapshot", status: vcsStatus("/p", { at: 5 }) }),
    );
    await act(async () =>
      useVcsStore.getState().apply("/p", { kind: "status", status: vcsStatus("/p", { at: 5, ahead: 1 }) }),
    );
    await settle();
    expect(listed()).toEqual(["/p"]);
  });

  it("Show ignored lists with showIgnored: true and is remembered on this device", async () => {
    const c = await show();
    expect(bed.called("files.list")[0]?.params).toEqual({ path: "/p", showIgnored: false });
    const toggle = c.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    await click(toggle as HTMLElement);
    await settle();
    expect(bed.called("files.list").at(-1)?.params).toEqual({ path: "/p", showIgnored: true });
    expect(localStorage.getItem("pap.files.showIgnored")).toBe("1");
  });

  it("drops the answer of an older listing round that arrives after the newer one", async () => {
    const pending: Array<(entries: ReturnType<typeof entry>[]) => void> = [];
    bed.handlers["files.list"] = () =>
      new Promise((resolve) => {
        pending.push((entries) => resolve({ entries, truncated: false }));
      });
    const c = await show();
    await click(c.querySelector('[role="switch"]') as HTMLElement);
    await settle();
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.([entry("new.txt")]));
    await act(async () => pending[0]?.([entry("old.txt")]));
    await settle();
    expect(rows(c).map((item) => item.dataset.path)).toEqual(["/p/new.txt"]);
  });

  it("starts with Show ignored on when the device remembers it", async () => {
    localStorage.setItem("pap.files.showIgnored", "1");
    await show();
    expect(bed.called("files.list")[0]?.params).toEqual({ path: "/p", showIgnored: true });
  });

  it("a row's drag start puts the absolute path in both data types", async () => {
    const c = await show();
    const target = row(c, "/p/README.md");
    expect(target.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" },
    });
    await act(async () => {
      target.dispatchEvent(event);
    });
    expect(Object.fromEntries(data)).toEqual({
      "application/x-pap-path": "/p/README.md",
      "text/plain": "/p/README.md",
    });
  });

  it("a name with a bidi override shows without it", async () => {
    bed = filesBed({ "/p": [entry(`ev${String.fromCodePoint(0x202e)}il.txt`)] });
    current.runtime = bed.runtime;
    const c = await show();
    expect(rows(c)[0]?.textContent).toContain("evil.txt");
    expect(rows(c)[0]?.textContent).not.toContain(String.fromCodePoint(0x202e));
  });

  it("remembers the expanded folders of a root across a remount", async () => {
    const c = await show();
    await click(row(c, "/p/src"));
    await settle();
    await unmountAll();
    bed.calls.length = 0;
    const again = await show();
    expect(rows(again).map((item) => item.dataset.path)).toContain("/p/src/main.ts");
    expect(listed()).toEqual(["/p", "/p/src"]);
  });

  it("says so when a folder cannot be listed", async () => {
    bed.handlers["files.list"] = (params) => {
      if ((params as { path: string }).path === "/p") return { entries: TREE["/p"], truncated: false };
      throw new RpcError("internal");
    };
    const c = await show();
    await click(row(c, "/p/src"));
    await settle();
    expect(c.textContent).toContain("Could not list this folder");
    bed.handlers["files.list"] = (params) => {
      if ((params as { path: string }).path === "/p") return { entries: TREE["/p"], truncated: false };
      throw new RpcError("not_found");
    };
    await click(c.querySelector('[data-slot="banner"] button') as HTMLElement);
    await settle();
    expect(c.textContent).toContain("This folder is gone or outside the project");
  });
});
