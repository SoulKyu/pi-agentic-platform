// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { tasksSnapshot, taskView } from "../../testing/home-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const recentRadio = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="segmented"][aria-labelledby] [role="radio"]')].find(
    (node) => node.textContent === name,
  ) as HTMLElement;
const rows = () => document.querySelectorAll("[data-recent-row]");

async function showBody(projectId: string | null = "p1") {
  resetHome(projectId);
  useTasksStore.getState().apply(tasksSnapshot([taskView({ id: "t1", createdAt: 1 })]));
  const shown = await showHome();
  await vi.waitFor(() => expect(document.querySelector("[data-home-body]")).not.toBeNull(), {
    timeout: 4_000,
  });
  await settle();
  return shown;
}

beforeEach(() => {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.github"] = () => ({ github: githubView({ link: null, clone: null }) });
  bed.handlers["projects.box"] = () => ({ box: boxView() });
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
  bed.handlers["projects.knowledge"] = () => ({ enabled: false, concepts: 0 });
});

describe("the project home design", () => {
  it("the home has one primary fill: Launch", async () => {
    await showBody();
    await vi.waitFor(() => expect(document.querySelector("[data-knowledge-row]")).not.toBeNull());
    const primaries = [...document.querySelectorAll<HTMLElement>('[data-variant="primary"]')];
    expect(primaries.map((node) => node.textContent)).toEqual(["Launch"]);
  });

  it("a box project with a stopped box has exactly one primary fill: Launch", async () => {
    resetHome("b1");
    useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
    useCurrentProject.setState({ projectId: "b1" });
    await showHome();
    await vi.waitFor(() => expect(document.querySelector("[data-box-fact]")).not.toBeNull(), {
      timeout: 4_000,
    });
    await settle();
    expect(button(document.body, "Start").disabled).toBe(false);
    const primaries = [...document.querySelectorAll<HTMLElement>('[data-variant="primary"]')];
    expect(primaries.map((node) => node.textContent)).toEqual(["Launch"]);
  });

  it("the recent work filter is a labelled group of four options with All selected", async () => {
    await showBody();
    const group = recentRadio("All").closest('[role="group"],[role="radiogroup"]') as HTMLElement;
    expect(document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Show");
    expect(recentRadio("All").getAttribute("aria-checked")).toBe("true");
    expect(recentRadio("Lanes").getAttribute("aria-checked")).toBe("false");
    expect(document.querySelectorAll('[data-slot="segmented"] [role="radio"]')).toHaveLength(4);
  });

  it("a filter with no rows says so, and Show all resets it", async () => {
    const { page } = await showBody();
    expect(rows()).toHaveLength(1);
    await click(recentRadio("Lanes"));
    expect(rows()).toHaveLength(0);
    expect(page.container.textContent).toContain("Nothing matches this filter.");
    await click(button(page.container, "Show all"));
    expect(rows()).toHaveLength(1);
    expect(recentRadio("All").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(recentRadio("All"));
  });

  it("the placeholder is an example, not the label again", async () => {
    await showBody();
    const placeholder = composer().placeholder;
    expect(placeholder).toBe("Fix the flaky login test, then open a PR");
    expect(placeholder).not.toBe("What to do");
    resetHome(null);
    await showHome();
    expect(composer().placeholder).toBe(
      "Fix the flaky login test, then open a PR. Launch asks which project.",
    );
  });

  it("the h1 is text-h1 and the body sections are gap-s5 apart", async () => {
    await showBody();
    expect(document.querySelector("h1")?.className).toContain("text-h1");
    expect(document.querySelector("[data-home-body]")?.className).toContain("gap-s5");
  });

  it("an unavailable action's reason is muted, never pink", async () => {
    await showBody(null);
    const files = button(document.body, "Files");
    const reason = document.getElementById(files.getAttribute("aria-describedby") ?? "");
    expect(reason?.className).toContain("text-muted");
    expect(reason?.className).not.toContain("text-attn");
  });

  it("a failed terminal start is red, never muted or pink", async () => {
    const bed = fakeRuntime("open");
    current.runtime = bed.runtime;
    bed.handlers["lanes.listArchived"] = () => ({ lanes: [], hasMore: false });
    bed.handlers["projects.knowledge"] = () => ({ enabled: false, concepts: 0 });
    bed.handlers["terminal.create"] = () => {
      throw new RpcError("forbidden");
    };
    const { page } = await showBody();
    await click(button(page.container, "Terminal"));
    await settle();
    const notice = document.querySelector<HTMLElement>("[data-home-actions] [role='alert']");
    expect(notice?.className).toContain("text-err");
    expect(notice?.className).not.toContain("text-attn");
  });
});
