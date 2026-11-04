// @vitest-environment happy-dom
import type { OverviewSnapshot } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { button, click, mount, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { OverviewCallbacks } from "./callbacks.ts";
import { NOW, memberSnapshot, ownerSnapshot } from "./overview-fixtures.ts";
import { OverviewPane } from "./OverviewPane.tsx";
import { callbacks, showIn } from "./overview-bed.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const show = (snapshot: OverviewSnapshot, on: OverviewCallbacks = callbacks()) => showIn(bed, snapshot, on);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  setLocale("en");
  useLaunchStore.getState().reset();
  vi.useRealTimers();
});

describe("OverviewPane: the band", () => {
  it("shows the owner's memory, workers and cost, and members' share of it", async () => {
    const root = await show(ownerSnapshot());
    const band = text(root.querySelector("[data-capacity-band]") as Element);
    expect(band).toContain("8.0 / 10.0 GB");
    expect(band).toContain("4 / 6");
    expect(band).toContain("$1.84");
    expect(band).toContain("of which members $0.27");
    expect(band).not.toContain("Full");
  });

  it("says it in French", async () => {
    setLocale("fr");
    const root = await show(ownerSnapshot());
    const band = text(root.querySelector("[data-capacity-band]") as Element);
    expect(band).toContain("8,0 / 10,0 Go");
    expect(band).toContain("dont membres $0.27");
  });

  it("FULL only when the daemon says memory is full; a dash when memory is unknown", async () => {
    const full = ownerSnapshot();
    if (full.capacity.role !== "owner") throw new Error("fixture");
    const loaded = await show({
      ...full,
      capacity: { ...full.capacity, memory: { usedMb: 10240, maxMb: 10240, full: true } },
    });
    expect(text(loaded.querySelector("[data-capacity-band]") as Element)).toContain("Full");
    const word = loaded.querySelector("[data-band-full]") as HTMLElement;
    expect(word.getAttribute("data-slot")).toBeNull();
    expect(word.className).not.toMatch(/attn|err|border/);
    expect(word.querySelector("[data-slot=chip-dot]")).toBeNull();
    await Promise.resolve();
  });

  it("memory cell reads a dash when memory is null", async () => {
    const base = ownerSnapshot();
    if (base.capacity.role !== "owner") throw new Error("fixture");
    const root = await show({ ...base, capacity: { ...base.capacity, memory: null } });
    const cell = root.querySelector("[data-band-memory]") as Element;
    expect(text(cell)).toContain("—");
    expect(text(cell)).not.toContain("GB");
  });

  it("the failures line counts one in the singular, in both languages", async () => {
    const base = ownerSnapshot();
    if (base.capacity.role !== "owner") throw new Error("fixture");
    const one = { ...base, capacity: { ...base.capacity, failures: 1 } };
    const singular = text(await show(one));
    expect(singular).toContain("1 recent failure");
    expect(singular).not.toContain("1 recent failures");
    expect(text(await show({ ...one, capacity: { ...one.capacity, failures: 3 } }))).toContain(
      "3 recent failures",
    );
    setLocale("fr");
    const french = text(await show(one));
    expect(french).toContain("1 échec récent");
    expect(french).not.toContain("1 échecs");
  });

  it("the owner's failures line opens Health", async () => {
    const base = ownerSnapshot();
    if (base.capacity.role !== "owner") throw new Error("fixture");
    const on = callbacks();
    const root = await show({ ...base, capacity: { ...base.capacity, failures: 3 } }, on);
    await click(button(root, "3 recent failures"));
    expect(on.openHealth).toHaveBeenCalledOnce();
  });

  it("a member sees the shared percentage and no GB of the host", async () => {
    const root = await show(memberSnapshot());
    const band = text(root.querySelector("[data-capacity-band]") as Element);
    expect(band).toContain("Shared capacity");
    expect(band).toContain("80%");
    expect(band).not.toContain("10.0");
    expect(band).toContain("Your cost today");
    expect(band).toContain("$0.50");
  });

  it("a member's percentage keeps the French space", async () => {
    setLocale("fr");
    const root = await show(memberSnapshot());
    expect(text(root.querySelector("[data-capacity-band]") as Element)).toContain("80 %");
  });

  it("a member without a budget says so", async () => {
    const base = memberSnapshot();
    if (base.capacity.role !== "member") throw new Error("fixture");
    const root = await show({ ...base, capacity: { ...base.capacity, cost: { usd: 0.5, budgetUsd: null } } });
    expect(text(root)).toContain("no budget");
  });
});

describe("OverviewPane: member lines", () => {
  const line = { userId: "u1", name: "Maya", activeBoxes: 2, reservedMb: 3072, costUsd: 0.27, budgetUsd: 5 };

  it("shows each member's counts for the owner, and no box name", async () => {
    const root = await show(ownerSnapshot({ members: [line] }));
    const lines = root.querySelector("[data-member-lines]") as HTMLElement;
    expect(text(lines)).toContain("Maya · member");
    expect(text(lines)).toContain("2");
    expect(text(lines)).toContain("3.0 GB");
    expect(text(lines)).toContain("$0.27");
    expect(text(lines)).not.toContain("Atlas");
    expect(text(root)).toContain("Members");
  });

  it("has no Members group for a member, whatever the snapshot holds", async () => {
    const root = await show(memberSnapshot({ members: [line] }));
    expect(root.querySelector("[data-member-lines]")).toBeNull();
    expect(text(root)).not.toContain("Maya");
  });

  it("has none when the owner has no members", async () => {
    const root = await show(ownerSnapshot());
    expect(root.querySelector("[data-member-lines]")).toBeNull();
  });
});

describe("OverviewPane: the phone (spec 3.7)", () => {
  const phone = (yes: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: yes && query === "(max-width: 767.98px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  afterEach(() => vi.unstubAllGlobals());
  const line = { userId: "u1", name: "Maya", activeBoxes: 0, reservedMb: 0, costUsd: 0.27, budgetUsd: 5 };

  it("keeps the three band cells in one row, narrow: no pane-wide minimum", async () => {
    phone(true);
    const root = await show(ownerSnapshot());
    const band = root.querySelector("[data-capacity-band]") as HTMLElement;
    expect(band.className).toContain("flex-nowrap");
    for (const cell of band.children) expect(cell.className).not.toContain("min-w-pane");
    expect(band.children).toHaveLength(3);
  });

  it("a desktop band still wraps its pane-wide cells", async () => {
    phone(false);
    const root = await show(ownerSnapshot());
    const band = root.querySelector("[data-capacity-band]") as HTMLElement;
    expect(band.className).toContain("flex-wrap");
    expect(band.children[0]?.className).toContain("min-w-pane");
  });

  it("stacks a member line's figures as two columns and mutes a 0", async () => {
    phone(true);
    const root = await show(ownerSnapshot({ members: [line] }));
    const row = root.querySelector("[data-member-lines] li") as HTMLElement;
    expect(row.className).toContain("grid-cols-2");
    expect(row.className).not.toContain("grid-cols-3");
    const zeros = [...row.querySelectorAll<HTMLElement>("[data-figure-value]")].filter(
      (value) => value.getAttribute("data-zero") === "",
    );
    expect(zeros.map((value) => value.textContent)).toEqual(["0", "0.0 GB"]);
    for (const value of zeros) expect(value.className).toContain("text-muted");
    const values = [...row.querySelectorAll<HTMLElement>("[data-figure-value]")];
    expect(values.at(-1)?.className).not.toContain("text-muted");
  });
});

describe("OverviewPane: loading and failure", () => {
  it("a first read that fails says so and offers to try again", async () => {
    bed.handlers["overview.get"] = () => Promise.reject(new Error("down"));
    const view = await mount(<OverviewPane {...callbacks()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text(view.container)).toContain("The overview could not be read.");
    bed.handlers["overview.get"] = () => ownerSnapshot();
    await click(button(view.container, "Try again"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector("[data-box-card]")).not.toBeNull();
  });
});
