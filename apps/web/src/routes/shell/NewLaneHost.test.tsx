// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { hasCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useNewLaneRequest } from "../../stores/new-lane-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, field, press, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

const preview = {
  repo: true,
  current: "main",
  refs: [],
  config: {
    found: true,
    error: null,
    warnings: [],
    branchPrefix: "pi/",
    waitForSetup: true,
    copy: [],
    link: [],
    scripts: [],
  },
  remote: null,
  forge: null,
};
let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["lanes.preview"] = () => preview;
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  current.runtime = bed.runtime;
  localStorage.clear();
  useCurrentProject.setState({ projectId: null });
  useShellStore.getState().reset();
  useLaneStore.getState().reset();
  useWorkspaceStore.setState({ ws: { tabs: [], active: null } });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

const withProjects = (...ids: string[]) =>
  useShellStore.getState().apply(shellSnapshot([], { projects: ids.map((id) => shellProject({ id })) }));
const chord = () => press(document.body, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });

describe("the new-lane host", () => {
  it("registers lanes.new while the shell is mounted, so the shortcut and the palette entry exist", async () => {
    expect(hasCommand("lanes.new")).toBe(false);
    const page = await renderShell("/");
    expect(hasCommand("lanes.new")).toBe(true);
    await page.unmount();
    expect(hasCommand("lanes.new")).toBe(false);
  });

  it("Ctrl+Shift+L opens the dialog for the switcher's project and the focus goes to the description", async () => {
    withProjects("a", "b");
    useCurrentProject.setState({ projectId: "b" });
    const page = await renderShell("/");
    await chord();
    await vi.waitFor(() => expect(bed.called("lanes.preview")).toHaveLength(1), { timeout: 2_000 });
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/b" });
    await vi.waitFor(
      () => expect(document.activeElement).toBe(field(document.body, "Issue or description")),
      {
        timeout: 2_000,
      },
    );
    await page.unmount();
  });

  it("does nothing without a project", async () => {
    const page = await renderShell("/");
    await chord();
    await settle();
    expect(document.querySelector('[data-slot="new-lane"]')).toBeNull();
    await page.unmount();
  });

  it("creating opens the new lane's tab", async () => {
    withProjects("a");
    bed.handlers["lanes.create"] = () => ({ laneIds: ["fix-1a2b"], fanoutId: null });
    const page = await renderShell("/");
    await chord();
    await vi.waitFor(() => expect(document.querySelector('[data-slot="new-lane"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    await vi.waitFor(() => field(document.body, "Issue or description"), { timeout: 2_000 });
    await typeInto(field(document.body, "Issue or description"), "Fix it");
    await click(button(document.body, "Create lane"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/lane/fix-1a2b");
    expect(document.querySelector('[data-slot="new-lane"]')).toBeNull();
    await page.unmount();
  });

  it("a fan-out opens the compare tab", async () => {
    withProjects("a");
    bed.handlers["lanes.create"] = () => ({
      laneIds: ["a-1a2b", "b-1a2b"],
      fanoutId: "0123456789abcdef",
    });
    const page = await renderShell("/");
    await chord();
    await vi.waitFor(() => field(document.body, "Issue or description"), { timeout: 2_000 });
    await typeInto(field(document.body, "Issue or description"), "Fix it");
    await click(button(document.body, "Add a model"));
    await click(button(document.body, "Create lane"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/compare/0123456789abcdef");
    expect(text(document.body)).not.toContain("Create lane");
    await page.unmount();
  });

  it("opens with a Run again request: its project, the prompt and a model row per lane, once", async () => {
    withProjects("a", "b");
    useCurrentProject.setState({ projectId: "a" });
    useNewLaneRequest
      .getState()
      .request({ projectRoot: "/w/b", text: "Replace the cache", models: [null, null] });
    const page = await renderShell("/");
    await chord();
    await vi.waitFor(() => expect(bed.called("lanes.preview")).toHaveLength(1), { timeout: 2_000 });
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/b" });
    await vi.waitFor(() => expect(text(document.body)).toContain("2 lanes"), { timeout: 2_000 });
    expect((field(document.body, "Issue or description") as HTMLTextAreaElement).value).toBe(
      "Replace the cache",
    );
    expect(useNewLaneRequest.getState().prefill).toBeNull();
    await page.unmount();
  });
});
