// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, mount, settle, text } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { vcsStatus } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ChangesPane } from "./ChangesPane.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ROOT = "/boxes/b1/project";
let bed: ReturnType<typeof fakeRuntime>;
let running = false;
beforeEach(() => {
  useVcsStore.getState().reset();
  bed = fakeRuntime("open");
  bed.handlers["projects.github"] = () => ({ github: githubView({ link: null }) });
  running = false;
  // The daemon refuses the subscription of a stopped box.
  bed.handlers["subscribe.vcs"] = () => {
    if (!running) throw new RpcError("box_stopped");
    return { sub: "v1" };
  };
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
});

describe("Changes in a stopped box", () => {
  it("shows START when the vcs stream answers box_stopped, and watches again once the box runs", async () => {
    const page = await mount(
      <TooltipProvider>
        <ChangesPane root={ROOT} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    await settle();
    expect(bed.called("subscribe.vcs")).toHaveLength(1);
    expect(text(page.container)).toContain("The project's box is stopped. Start it to see its files.");
    expect(button(page.container, "START")).toBeDefined();

    running = true;
    await act(async () => {
      useShellStore.getState().apply({ kind: "project", project: boxProject("running") });
    });
    await settle();
    expect(bed.called("subscribe.vcs")).toHaveLength(2);
    await act(async () => {
      useVcsStore.getState().apply(ROOT, { kind: "snapshot", status: vcsStatus(ROOT, { files: [] }) });
    });
    expect(text(page.container)).not.toContain("is stopped");
  });
});
