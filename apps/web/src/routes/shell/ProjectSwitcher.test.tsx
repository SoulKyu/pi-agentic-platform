// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import * as report from "../../lib/report.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let bed: ReturnType<typeof fakeRuntime>;
// Works around act() meeting a cold lazy chunk (its retry waits for act to exit); not a product bug: the menu opens on the first press.
beforeAll(async () => {
  await import("@pap/ui/overlays");
  await import("./TreeDrawer.tsx");
});
let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useCurrentProject.setState({ projectId: null, storageRefused: false });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const feed = (sessions: ReturnType<typeof shellSession>[], patch: Parameters<typeof shellSnapshot>[1] = {}) =>
  act(async () => bed.emitTo("subscribe.shell", shellSnapshot(sessions, patch)));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const trigger = () => document.querySelector('button[aria-label^="Project: "]') as HTMLButtonElement;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const labels = () => items().map((item) => item.textContent);
async function openSwitcher() {
  // The first press asks for the menu's chunk; once mounted, Radix opens on the keyboard.
  await click(trigger());
  await act(async () => {
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), {
      timeout: 2_000,
    });
  });
}
const pick = async (label: string) => {
  const item = items().find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`no item ${label}`);
  await click(item);
  await settle();
};

const three = () =>
  feed(
    [
      shellSession({ id: "a1", projectId: "api", updatedAt: 3 }),
      shellSession({ id: "a2", projectId: "api", updatedAt: 2 }),
      shellSession({ id: "w1", projectId: "web", updatedAt: 1 }),
      shellSession({ id: "pin", projectId: "api", updatedAt: 0, pinRank: 1 }),
    ],
    {
      projects: [
        shellProject({ id: "api", name: "api", position: 1, sessions: 2 }),
        shellProject({ id: "web", name: "web", position: 2, sessions: 1 }),
        shellProject({ id: "idle", name: "idle", position: 3, sessions: 0 }),
      ],
    },
  );

describe("the project switcher", () => {
  it("is a bordered mono chip with the HUD label (boards 05 and 09), still a button named after the project", async () => {
    const page = await renderShell("/");
    await settle();
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().className).toContain("border-control-border");
    expect(trigger().className).toContain("label-hud");
    expect(trigger().className).not.toContain("border-transparent");
    await page.unmount();
  });

  it("says All projects, lists the projects that have an active session in order, and none that is idle", async () => {
    const page = await renderShell("/");
    await settle();
    await three();
    expect(trigger().textContent).toBe("All projects");
    expect(trigger().getAttribute("aria-label")).toBe("Project: All projects");
    await openSwitcher();
    expect(labels()).toEqual(["All projects", "api", "web"]);
    await page.unmount();
  });

  it("choosing web shows web in the button, keeps it for the device, and narrows the tree to web plus the pinned", async () => {
    const page = await renderShell("/");
    await settle();
    await three();
    await openSwitcher();
    await pick("web");
    expect(trigger().textContent).toBe("web");
    expect(trigger().getAttribute("aria-label")).toBe("Project: web");
    expect(localStorage.getItem("pap.project.v1")).toBe('{"v":1,"projectId":"web"}');
    await press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    await vi.waitFor(() => expect(dialog()?.querySelector("[data-project-tree]") ?? null).not.toBeNull(), {
      timeout: 2_000,
    });
    const groups = [...(dialog()?.querySelectorAll("[data-group]") ?? [])];
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["web"]);
    expect(
      [...(dialog()?.querySelectorAll("a") ?? [])].map((row) => row.getAttribute("href")).sort(),
    ).toEqual(["/s/pin", "/s/w1"]);
    await page.unmount();
  });

  it("All projects clears the choice", async () => {
    useCurrentProject.setState({ projectId: "web" });
    const page = await renderShell("/");
    await settle();
    await three();
    expect(trigger().textContent).toBe("web");
    await openSwitcher();
    await pick("All projects");
    expect(trigger().textContent).toBe("All projects");
    expect(localStorage.getItem("pap.project.v1")).toBe('{"v":1,"projectId":null}');
    await page.unmount();
  });

  it("a stored id the store does not know shows All projects and narrows nothing, then applies once it is known (RT-36)", async () => {
    useCurrentProject.setState({ projectId: "later" });
    const page = await renderShell("/");
    await settle();
    await three();
    expect(trigger().textContent).toBe("All projects");
    await press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    await vi.waitFor(() => expect(dialog()?.querySelector("[data-project-tree]") ?? null).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(
      [...(dialog()?.querySelectorAll("[data-group]") ?? [])].map((group) =>
        group.getAttribute("data-group"),
      ),
    ).toEqual(["api", "web"]);
    expect(useCurrentProject.getState().projectId).toBe("later");
    await feed([shellSession({ id: "l1", projectId: "later" })], {
      projects: [shellProject({ id: "later", name: "later", sessions: 1 })],
    });
    expect(trigger().textContent).toBe("later");
    await page.unmount();
  });

  it("lists every one of 120 active projects", async () => {
    const page = await renderShell("/");
    await settle();
    const projects = Array.from({ length: 120 }, (_, i) =>
      shellProject({ id: `p${i}`, name: `proj-${i}`, position: i + 1, sessions: 1 }),
    );
    await feed(
      projects.map((project) => shellSession({ id: `s-${project.id}`, projectId: project.id })),
      { projects },
    );
    await openSwitcher();
    expect(items()).toHaveLength(121);
    expect(labels().at(-1)).toBe("proj-119");
    await page.unmount();
  });

  it("ends with a disabled line when projects are not listed, singular and plural", async () => {
    const page = await renderShell("/");
    await settle();
    await three();
    await feed([shellSession({ id: "a1", projectId: "api" })], {
      projects: [shellProject({ id: "api", name: "api", sessions: 1 })],
      moreProjects: 7,
    });
    await openSwitcher();
    const last = items().at(-1) as HTMLElement;
    expect(last.textContent).toBe("7 more projects are not listed");
    expect(last.hasAttribute("data-disabled") || last.getAttribute("aria-disabled") === "true").toBe(true);
    await page.unmount();
  });

  it("says 1 more project in the singular", async () => {
    const page = await renderShell("/");
    await settle();
    await feed([], { projects: [], moreProjects: 1 });
    await openSwitcher();
    expect(labels()).toEqual(["All projects", "1 more project is not listed"]);
    await page.unmount();
  });

  it("Escape closes the menu and keeps the choice", async () => {
    const page = await renderShell("/");
    await settle();
    await three();
    await openSwitcher();
    await press(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().textContent).toBe("All projects");
    await page.unmount();
  });

  it("reports a refused write once and still uses the choice for this page", async () => {
    const issue = vi.mocked(report.reportClientIssue);
    issue.mockClear();
    const page = await renderShell("/");
    await settle();
    await three();
    await openSwitcher();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      clear: () => {},
    });
    await pick("api");
    expect(trigger().textContent).toBe("api");
    expect(issue.mock.calls).toEqual([["storage_refused"]]);
    await page.unmount();
  });
});
