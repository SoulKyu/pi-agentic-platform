// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, mount, press } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ownerSnapshot } from "./overview-fixtures.ts";
import { callbacks, showIn } from "./overview-bed.tsx";
import { OverviewPane } from "./OverviewPane.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => vi.unstubAllGlobals());

const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const sheetRows = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')];
const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches && query === "(max-width: 767.98px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe("OverviewPane: the header's + menu (R8)", () => {
  it("offers New agent and New project on a desktop, and each calls its callback", async () => {
    phone(false);
    const on = callbacks();
    const root = await showIn(bed, ownerSnapshot(), on);
    await press(button(root, "New"), { key: "Enter" });
    await vi.waitFor(() =>
      expect(rows().map((row) => row.textContent)).toEqual(["New agent", "New project"]),
    );
    await click(rows()[0] as HTMLElement);
    expect(on.newAgent).toHaveBeenCalledTimes(1);
    expect(on.newProject).not.toHaveBeenCalled();
    await press(button(root, "New"), { key: "Enter" });
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(rows()[1] as HTMLElement);
    expect(on.newProject).toHaveBeenCalledTimes(1);
  });

  it("is a sheet on a phone, with the same two entries", async () => {
    phone(true);
    const on = callbacks();
    const root = await showIn(bed, ownerSnapshot(), on);
    await click(button(root, "New"));
    const labels = sheetRows().map((row) => row.textContent);
    expect(labels).toEqual(expect.arrayContaining(["New agent", "New project"]));
    await click(sheetRows().find((row) => row.textContent === "New project") as HTMLElement);
    expect(on.newProject).toHaveBeenCalledTimes(1);
  });

  it("is in the header while the first read is still out", async () => {
    phone(false);
    bed.handlers["overview.get"] = () => new Promise(() => undefined);
    const view = await mount(<OverviewPane {...callbacks()} />);
    expect(button(view.container, "New")).toBeTruthy();
  });
});
