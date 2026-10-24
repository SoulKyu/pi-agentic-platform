// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, press, settle, typeInto } from "../../testing/dom.ts";
import { chip, composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomeBody.tsx", () => ({ default: () => null }));

let bed: ReturnType<typeof fakeRuntime>;
const picker = () => document.querySelector("[data-project-picker]") as HTMLElement | null;
const waitPicker = () => vi.waitFor(() => expect(picker()).not.toBeNull(), { timeout: 2_000 });
const choices = () => [...(picker()?.querySelectorAll("button") ?? [])].map((node) => node.textContent);

beforeAll(async () => {
  await import("./ProjectPicker.tsx");
  await import("./run-launch.ts");
});
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
  resetHome(null);
});

describe("ProjectHome under All projects (§3.5, PH13)", () => {
  it("asks which project at Launch, lists the projects then New project…, and launches in the one picked", async () => {
    useShellStore.getState().apply({
      kind: "project",
      project: shellProject({
        id: "p3",
        name: "fresh",
        root: "/w/fresh",
        position: 3,
        sessions: 0,
        unused: true,
      }),
    });
    const { page, actions } = await showHome();
    expect(page.container.querySelector("h1")?.textContent).toBe("All projects");
    expect(composer().getAttribute("placeholder")).toBe("What do you want to do? Launch asks which project.");
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    await click(button(page.container, "Launch a lane"));
    await waitPicker();
    expect(choices()).toEqual(["api", "web", "fresh", "Scratch", "New project…", "Cancel"]);
    expect(document.activeElement?.textContent).toBe("api");
    await click(button(picker() as HTMLElement, "web"));
    await settle();
    expect(actions.newLane).toHaveBeenCalledExactlyOnceWith({
      projectRoot: "/w/web",
      title: "Fix",
      text: "Fix",
      models: [null],
    });
    expect(picker()).toBeNull();
    expect(useCurrentProject.getState().projectId).toBeNull();
  });

  it("Scratch opens the owner's one Scratch project and launches in it", async () => {
    const scratch = {
      id: "sc1",
      root: "/boxes/sc1/project",
      name: "Scratch",
      position: 0,
      kind: "box",
      scratch: true,
    };
    bed.handlers["projects.scratch"] = () => ({ project: scratch });
    const { page } = await showHome();
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    expect(picker()?.textContent).toContain("An empty project for quick sessions.");
    await click(button(picker() as HTMLElement, "Scratch"));
    await settle();
    expect(bed.called("projects.scratch")).toHaveLength(1);
    expect(bed.called("sessions.create")[0]?.params).toEqual({
      cwd: "/boxes/sc1/project",
      preset: "configured",
    });
  });

  it("a Session launch asks too, then creates the session in the chosen project's root", async () => {
    const { page } = await showHome();
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    await click(button(picker() as HTMLElement, "api"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "configured" });
  });

  it("New project… opens the dialog, and the launch goes on in the project once it is added", async () => {
    const { page, actions } = await showHome();
    await click(chip("Trigger"));
    await typeInto(composer(), "Nightly");
    await click(button(page.container, "Launch a trigger"));
    await waitPicker();
    await click(button(picker() as HTMLElement, "New project…"));
    expect(actions.addProject).toHaveBeenCalledOnce();
    const onAdded = actions.addProject.mock.calls[0]?.[0];
    await act(async () => {
      useShellStore.getState().apply({
        kind: "project",
        project: { id: "p9", root: "/w/new", name: "new", position: 0, sessions: 0, unused: true },
      });
      useCurrentProject.getState().choose("p9");
      onAdded?.("p9");
    });
    await settle();
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p9", { name: "Nightly", prompt: "Nightly" });
  });

  it("New project… puts the focus on the composer before the dialog opens, so Cancel returns there (§7)", async () => {
    const { page, actions } = await showHome();
    let focused: Element | null = null;
    actions.addProject.mockImplementation(() => {
      focused = document.activeElement;
    });
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    await click(button(picker() as HTMLElement, "New project…"));
    expect(actions.addProject).toHaveBeenCalledOnce();
    expect(focused).toBe(composer());
  });

  it("Escape closes the picker and gives the focus back to the composer", async () => {
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await waitPicker();
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(composer());
    expect(actions.open).not.toHaveBeenCalled();
  });
});
