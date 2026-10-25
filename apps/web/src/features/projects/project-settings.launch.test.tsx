// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { mount, settle } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const project = () => boxProject("starting", { id: PROJECT_BOX, root: "/boxes/p/project" });
const launching = () =>
  act(async () => {
    useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("vm", Date.now() - 2000) });
  });

beforeEach(() => {
  useLaunchStore.getState().reset();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [project()] }));
});

describe("project settings launch progress", () => {
  it("project settings put the strip on the phase chip's line", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "starting" }) });
    bed.handlers["projects.github"] = () => ({ github: githubView({ link: null }) });
    bed.handlers["github.repositories"] = () => ({ repositories: [] });
    current.runtime = bed.runtime;
    await mount(
      <TooltipProvider>
        <StepUpContext.Provider value={(async (run) => run("c")) as StepUpRunner}>
          <ProjectSettings projectId={PROJECT_BOX} onClose={() => {}} />
        </StepUpContext.Provider>
      </TooltipProvider>,
    );
    await settle();
    await launching();
    const strip = document.querySelector("[data-project-settings] [data-launch-strip]") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.closest("[data-phase-row]")?.querySelector('[data-slot="chip"]')).not.toBeNull();
  });
});
