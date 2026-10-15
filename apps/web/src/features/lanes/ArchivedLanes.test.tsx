// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import ArchivedLanes from "./ArchivedLanes.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const archived = (id: string, at: number, patch = {}) =>
  laneView({ id, state: "archived", archivedAt: at, title: `Title ${id}`, branch: `pi/${id}`, ...patch });
const pr = {
  number: 9,
  url: "https://github.com/o/r/pull/9",
  state: "merged",
  draft: false,
  conflicts: null,
  checks: null,
  checkedAt: 1,
  error: null,
};

describe("archived lanes", () => {
  it("lists title, branch, PR link and archived date", async () => {
    const bed = newBed();
    bed.handlers["lanes.listArchived"] = () => ({
      lanes: [archived("a-1a2b", Date.UTC(2026, 9, 1), { pr })],
      hasMore: false,
    });
    const page = await mount(inShell(<ArchivedLanes count={1} onPick={() => {}} />));
    await settle();
    expect(bed.called("lanes.listArchived")[0]?.params).toEqual({});
    const content = text(page.container);
    expect(content).toContain("Title a-1a2b");
    expect(content).toContain("pi/a-1a2b");
    expect(content).toContain("2026");
    const link = page.container.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    expect(link.rel).toContain("noopener");
    expect(hasButton(page.container, "Load more")).toBe(false);
  });

  it("pages with `before` from the last row", async () => {
    const bed = newBed();
    bed.handlers["lanes.listArchived"] = (params) =>
      (params as { before?: unknown }).before === undefined
        ? { lanes: [archived("a-1a2b", 300), archived("b-1a2b", 200)], hasMore: true }
        : { lanes: [archived("c-1a2b", 100)], hasMore: false };
    const page = await mount(inShell(<ArchivedLanes count={3} onPick={() => {}} />));
    await settle();
    await click(button(page.container, "Load more"));
    await settle();
    expect(bed.called("lanes.listArchived")[1]?.params).toEqual({
      before: { archivedAt: 200, id: "b-1a2b" },
    });
    expect(text(page.container)).toContain("Title c-1a2b");
    expect(hasButton(page.container, "Load more")).toBe(false);
  });

  it("does not link a pull request address that is not http(s)", async () => {
    const bed = newBed();
    bed.handlers["lanes.listArchived"] = () => ({
      lanes: [archived("a-1a2b", 1, { pr: { ...pr, url: "javascript:alert(1)" } })],
      hasMore: false,
    });
    const page = await mount(inShell(<ArchivedLanes count={1} onPick={() => {}} />));
    await settle();
    expect(page.container.querySelector("a")).toBeNull();
  });

  it("shows a failed page with Try again", async () => {
    const bed = newBed();
    let fail = true;
    bed.handlers["lanes.listArchived"] = () => {
      if (fail) throw new Error("x");
      return { lanes: [archived("a-1a2b", 1)], hasMore: false };
    };
    const page = await mount(inShell(<ArchivedLanes count={1} onPick={() => {}} />));
    await settle();
    expect(text(page.container)).toContain("The archived lanes could not be loaded");
    fail = false;
    await click(button(page.container, "Try again"));
    await settle();
    expect(text(page.container)).toContain("Title a-1a2b");
  });
});
