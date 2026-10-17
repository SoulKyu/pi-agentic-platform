// @vitest-environment happy-dom
import type { ModelsOverview } from "@pap/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount, settle } from "../../../testing/dom.ts";
import { availabilityBed, current, overviewOfWorld } from "./availability-world.ts";
import { useAvailability } from "./use-availability.ts";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

type Seen = ReturnType<typeof useAvailability>;

function setup() {
  const made = availabilityBed();
  const seen: { now: Seen | null } = { now: null };
  const reloadOverview = vi.fn();
  const overview: ModelsOverview = overviewOfWorld(made.world);
  function Probe({ value }: { readonly value: ModelsOverview }) {
    seen.now = useAvailability({ value, reload: reloadOverview });
    return null;
  }
  return { ...made, seen, Probe, overview, reloadOverview };
}

/** A read the test answers by hand. */
function held() {
  const waiting: Array<(answer: unknown) => void> = [];
  return {
    handler: () => new Promise((resolve) => waiting.push(resolve)),
    waiting,
  };
}

const ids = (seen: { now: Seen | null }) =>
  seen.now?.available.status === "ready" ? seen.now.available.models.map((model) => model.id) : [];
const only = (...list: string[]) => ({
  models: list.map((id) => ({ provider: "openai", id, name: id, reasoning: false })),
  providers: [{ id: "openai", name: "OpenAI" }],
  origin: "scope",
  truncated: false,
});

describe("mode", () => {
  it("is all with no list and selection with one", async () => {
    const one = setup();
    await mount(<one.Probe value={one.overview} />);
    await settle();
    expect(one.seen.now?.mode).toBe("selection");
    const none = setup();
    await mount(
      <none.Probe value={{ ...none.overview, enabled: { ...none.overview.enabled, patterns: null } }} />,
    );
    await settle();
    expect(none.seen.now?.mode).toBe("all");
  });
});

describe("availability.reload-not-overtaken (MP-RT-14)", () => {
  it("never shows the answer of a read that started before a write once that write asked for a reload", async () => {
    const { bed, seen, Probe, overview } = setup();
    await mount(<Probe value={overview} />);
    await settle();
    expect(ids(seen)).toEqual(["gpt-a", "m1"]);

    // A read starts (a retry) and stays unanswered ...
    const old = held();
    bed.handlers["models.available"] = old.handler;
    await act(async () => seen.now?.reload());
    expect(old.waiting).toHaveLength(1);
    // ... a write finishes, and its reload waits behind that read ...
    await act(async () => seen.now?.write({ op: "clear" }));
    await settle();
    const fresh = held();
    bed.handlers["models.available"] = fresh.handler;

    // ... the old read answers late with the pre-write list: it must not be shown.
    await act(async () => old.waiting[0]?.(only("PRE-WRITE")));
    await settle();
    expect(ids(seen)).not.toContain("PRE-WRITE");
    await act(async () => fresh.waiting[0]?.(only("post-write")));
    await settle();
    expect(ids(seen)).toEqual(["post-write"]);
  });
});

describe("one read in flight", () => {
  it("turns rapid reloads into at most one running read and one trailing read", async () => {
    const { bed, seen, Probe, overview } = setup();
    await mount(<Probe value={overview} />);
    await settle();
    const wait = held();
    bed.handlers["models.available"] = wait.handler;
    const before = bed.called("models.available").length;
    await act(async () => {
      for (let click = 0; click < 10; click += 1) seen.now?.reload();
    });
    expect(bed.called("models.available").length - before).toBe(1);
    await act(async () => wait.waiting[0]?.(only("a")));
    await settle();
    expect(bed.called("models.available").length - before).toBe(2);
    await act(async () => wait.waiting[1]?.(only("b")));
    await settle();
    expect(bed.called("models.available").length - before).toBe(2);
    expect(ids(seen)).toEqual(["b"]);
  });

  it("reads again when the overview changes", async () => {
    const { bed, Probe, overview } = setup();
    const page = await mount(<Probe value={overview} />);
    await settle();
    const before = bed.called("models.available").length;
    await page.rerender(<Probe value={{ ...overview }} />);
    await settle();
    expect(bed.called("models.available").length - before).toBe(1);
  });

  it("drops an answer that arrives after the view is gone", async () => {
    const { bed, Probe, overview, seen } = setup();
    const wait = held();
    bed.handlers["models.available"] = wait.handler;
    const page = await mount(<Probe value={overview} />);
    await page.unmount();
    await act(async () => wait.waiting[0]?.(only("late")));
    expect(seen.now?.available.status).toBe("loading");
  });
});

describe("write", () => {
  it("sends the op without a step-up and reloads the overview and the preview", async () => {
    const { bed, seen, Probe, overview, reloadOverview } = setup();
    await mount(<Probe value={overview} />);
    await settle();
    const before = bed.called("models.available").length;
    await act(async () => seen.now?.write({ op: "prune" }));
    await settle();
    expect(bed.called("models.setEnabled").map((call) => call.params)).toEqual([{ op: { op: "prune" } }]);
    expect(bed.called("models.setEnabled")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(reloadOverview).toHaveBeenCalled();
    expect(bed.called("models.available").length).toBeGreaterThan(before);
  });
});
