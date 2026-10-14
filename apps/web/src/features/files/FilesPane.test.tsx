// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import { dirEntry, entry, filesBed, meta } from "./files-bed.ts";
import { FilesPane } from "./FilesPane.tsx";
import { resetFolderMemory } from "./folder-memory.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@pap/ui/code", async () => {
  const { createElement } = await import("react");
  return {
    CodeEditor: (props: { value: string }) =>
      createElement("pre", { "data-slot": "code-editor" }, props.value),
    languageFor: () => null,
  };
});

const FILES = Array.from({ length: 9 }, (_, index) => `f${index}.txt`);
let bed: ReturnType<typeof filesBed>;
beforeEach(() => {
  localStorage.clear();
  resetFolderMemory();
  bed = filesBed({ "/p": [dirEntry("sub"), ...FILES.map((name) => entry(name))] });
  bed.handlers["files.read"] = (params) => {
    const { path } = params as { path: string };
    return { meta: meta(path), text: `body of ${path}`, offset: 0, nextOffset: null };
  };
  current.runtime = bed.runtime;
});

async function show() {
  const page = await mount(
    <TooltipProvider>
      <FilesPane root="/p" />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
const open = async (c: HTMLElement, name: string) => {
  await click(c.querySelector(`[role="treeitem"][data-path="/p/${name}"]`) as HTMLElement);
  await settle();
};
const tabNames = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

describe("FilesPane", () => {
  it("is the explorer, and the viewer shows the file that is opened", async () => {
    const c = await show();
    expect(c.querySelector("[data-files-pane]")?.getAttribute("data-files-pane")).toBe("/p");
    expect(c.querySelector('[role="tree"]')).not.toBeNull();
    await open(c, "f0.txt");
    expect(tabNames(c)).toEqual(["f0.txt"]);
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("body of /p/f0.txt");
    expect(bed.called("files.read")[0]?.params).toEqual({ path: "/p/f0.txt", offset: 0 });
  });

  it("a 9th file closes the oldest clean tab", async () => {
    const c = await show();
    for (const name of FILES.slice(0, 8)) await open(c, name);
    expect(tabNames(c)).toHaveLength(8);
    await open(c, "f8.txt");
    expect(tabNames(c)).toEqual([...FILES.slice(1)]);
    expect(c.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("f8.txt");
  });

  it("closing the active tab shows the neighbour; closing the last shows the empty state", async () => {
    const c = await show();
    await open(c, "f0.txt");
    await open(c, "f1.txt");
    await click(c.querySelector('button[aria-label="Close f1.txt"]') as HTMLElement);
    await settle();
    expect(c.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("f0.txt");
    await click(c.querySelector('button[aria-label="Close f0.txt"]') as HTMLElement);
    await settle();
    expect(tabNames(c)).toEqual([]);
    expect(c.textContent).toContain("Select a file to see it here");
  });

  it("opening an open file selects its tab without a second tab", async () => {
    const c = await show();
    await open(c, "f0.txt");
    await open(c, "f1.txt");
    await open(c, "f0.txt");
    expect(tabNames(c)).toEqual(["f0.txt", "f1.txt"]);
    expect(c.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("f0.txt");
  });
});
