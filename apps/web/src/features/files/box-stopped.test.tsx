// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { entry, filesBed } from "./files-bed.ts";
import { FilesPane } from "./FilesPane.tsx";
import { resetFolderMemory } from "./folder-memory.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ROOT = "/boxes/b1/project";
let bed: ReturnType<typeof filesBed>;
let running: boolean;
beforeEach(() => {
  localStorage.clear();
  resetFolderMemory();
  running = false;
  bed = filesBed({ [ROOT]: [entry("README.md")] });
  const list = bed.handlers["files.list"];
  bed.handlers["files.list"] = (params) => {
    if (!running) throw new RpcError("box_stopped");
    return list?.(params);
  };
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
});

describe("Files in a stopped box", () => {
  it("Files shows START on box_stopped and reloads when running", async () => {
    const page = await mount(
      <TooltipProvider>
        <FilesPane root={ROOT} />
      </TooltipProvider>,
    );
    await settle();
    const c = page.container;
    expect(text(c)).toContain("The project's box is stopped. Start it to see its files.");
    expect(c.querySelector('[role="tree"]')).toBeNull();
    await click(button(c, "Start"));
    expect(bed.called("projects.startBox")[0]?.params).toEqual({ projectId: "b1" });

    running = true;
    await act(async () => {
      useShellStore.getState().apply({ kind: "project", project: boxProject("running") });
    });
    await settle();
    expect(c.querySelector('[role="treeitem"][data-path="/boxes/b1/project/README.md"]')).not.toBeNull();
    expect(text(c)).not.toContain("is stopped");
  });
});
