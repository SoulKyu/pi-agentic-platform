// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { entry, filesBed, meta } from "./files-bed.ts";
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
    CodeEditor: (props: { value: string; line?: { n: number; key: number } }) =>
      createElement(
        "pre",
        { "data-slot": "code-editor", "data-line": props.line === undefined ? "" : String(props.line.n) },
        props.value,
      ),
    languageFor: () => null,
  };
});

let bed: ReturnType<typeof filesBed>;
beforeEach(() => {
  localStorage.clear();
  resetFolderMemory();
  useFilesTarget.getState().reset();
  bed = filesBed({ "/p": [entry("a.ts"), entry("README.md")] });
  bed.handlers["files.read"] = (params) => {
    const { path } = params as { path: string };
    return { meta: meta(path), text: `body of ${path}`, offset: 0, nextOffset: null };
  };
  current.runtime = bed.runtime;
});

const show = async (root = "/p") => {
  const page = await mount(
    <TooltipProvider>
      <FilesPane root={root} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
};
const tabNames = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
const editor = (c: HTMLElement) => c.querySelector('[data-slot="code-editor"]');

describe("FilesPane target", () => {
  it("a pushed target opens its file and the editor lands on line 12", async () => {
    useFilesTarget.getState().push("/p", "/p/a.ts", 12);
    const c = await show();
    expect(tabNames(c)).toEqual(["a.ts"]);
    expect(editor(c)?.getAttribute("data-line")).toBe("12");
    expect(useFilesTarget.getState().targets).toEqual({});
  });

  it("a target pushed while the pane is open opens too, and a path with no line has no line", async () => {
    const c = await show();
    await act(async () => useFilesTarget.getState().push("/p", "/p/a.ts", null));
    await settle();
    expect(tabNames(c)).toEqual(["a.ts"]);
    expect(editor(c)?.getAttribute("data-line")).toBe("");
  });

  it("a Markdown target with a line opens in Source", async () => {
    useFilesTarget.getState().push("/p", "/p/README.md", 3);
    const c = await show();
    expect(editor(c)?.getAttribute("data-line")).toBe("3");
    expect(c.querySelector('[role="radio"][aria-checked="true"], [aria-pressed="true"]')?.textContent).toBe(
      "Source",
    );
  });

  it("a Markdown target without a line stays in Preview", async () => {
    useFilesTarget.getState().push("/p", "/p/README.md", null);
    const c = await show();
    expect(tabNames(c)).toEqual(["README.md"]);
    expect(editor(c)).toBeNull();
  });

  it("a stopped box shows START and the target opens once the root lists", async () => {
    const root = "/boxes/b1/project";
    let running = false;
    bed = filesBed({ [root]: [entry("a.ts")] });
    const list = bed.handlers["files.list"];
    bed.handlers["files.list"] = (params) => {
      if (!running) throw new RpcError("box_stopped");
      return list?.(params);
    };
    bed.handlers["files.read"] = (params) => {
      const { path } = params as { path: string };
      return { meta: meta(path), text: "x", offset: 0, nextOffset: null };
    };
    current.runtime = bed.runtime;
    useShellStore.getState().reset();
    useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
    useFilesTarget.getState().push(root, `${root}/a.ts`, 5);
    const c = await show(root);
    expect(text(c)).toContain("The project's box is stopped");
    expect(bed.called("files.read")).toEqual([]);
    await click(button(c, "Start"));
    running = true;
    await act(async () => {
      useShellStore.getState().apply({ kind: "project", project: boxProject("running") });
    });
    await settle();
    expect(tabNames(c)).toEqual(["a.ts"]);
    expect(editor(c)?.getAttribute("data-line")).toBe("5");
  });

  it("a target for another root is left alone", async () => {
    useFilesTarget.getState().push("/other", "/other/a.ts", 2);
    const c = await show();
    expect(tabNames(c)).toEqual([]);
    expect(useFilesTarget.getState().targets["/other"]).toMatchObject({ path: "/other/a.ts" });
  });
});
