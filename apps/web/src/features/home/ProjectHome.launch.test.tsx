// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import { fakeHomeActions } from "../../testing/home-actions.ts";
import { resetHome, showHome } from "../../testing/home-bed.tsx";
import { boxView } from "../../testing/box-fixtures.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./ProjectFacts.tsx", () => ({ default: () => null }));
// Not under test, and the bed answers none of its reads: an unanswered read threw while rendering and the boundary retried.
vi.mock("../github/GithubHomeEntry.tsx", () => ({ GithubHomeEntry: () => null }));

beforeEach(() => {
  useLaunchStore.getState().reset();
  resetHome();
  useShellStore.getState().apply(
    shellSnapshot([], {
      projects: [
        shellProject({
          id: PROJECT_BOX,
          name: "api",
          root: "/boxes/api",
          kind: "box",
          box: { phase: "stopped" },
        }),
      ],
    }),
  );
});

describe("ProjectHome launch progress", () => {
  it("pressing Launch on a stopped box shows the steps of its launch", async () => {
    const bed = fakeRuntime("open");
    // BoxFact reads the box; without an answer it rendered `undefined.packages`, threw, and the boundary retried until the 5 s ran out.
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    let finish: (() => void) | undefined;
    bed.handlers["sessions.create"] = () =>
      new Promise((resolve) => {
        finish = () => resolve({ sessionId: "s-1" });
      });
    current.runtime = bed.runtime;
    const { page } = await showHome(fakeHomeActions());
    await act(async () => {
      (await import("../../stores/current-project.ts")).useCurrentProject.getState().choose(PROJECT_BOX);
    });
    await click(button(page.container, "Launch a session"));
    expect(page.container.querySelector("[data-launch-panel]")).toBeNull();
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("image", Date.now() - 3000) });
    });
    await vi.waitFor(() => expect(page.container.querySelector("[data-launch-panel]")).not.toBeNull());
    expect(text(page.container)).toContain("Building the image");
    expect(page.container.querySelectorAll("[data-launch-panel] li").length).toBe(5);
    await act(async () => {
      finish?.();
    });
    await settle();
  });

  it("the project home shows one step panel during a launch", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    let finish: (() => void) | undefined;
    bed.handlers["sessions.create"] = () =>
      new Promise((resolve) => {
        finish = () => resolve({ sessionId: "s-1" });
      });
    current.runtime = bed.runtime;
    const { page } = await showHome(fakeHomeActions());
    await act(async () => {
      (await import("../../stores/current-project.ts")).useCurrentProject.getState().choose(PROJECT_BOX);
    });
    await click(button(page.container, "Launch a session"));
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("image", Date.now() - 3000) });
    });
    // Asked from this screen: the box line's panel is open by default, and it is the only one.
    await vi.waitFor(() => expect(page.container.querySelectorAll("[data-launch-panel]").length).toBe(1));
    expect(page.container.querySelector("[data-box-fact] [data-launch-panel]")).not.toBeNull();
    // Its toggle hides it and shows it again: never a second copy.
    await click(button(page.container, "Hide the steps"));
    expect(page.container.querySelectorAll("[data-launch-panel]").length).toBe(0);
    await click(button(page.container, "Show the steps"));
    await vi.waitFor(() => expect(page.container.querySelectorAll("[data-launch-panel]").length).toBe(1));
    await act(async () => {
      finish?.();
    });
    await settle();
  });
});
