// @vitest-environment happy-dom
import type { HealthEvent } from "@pap/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { useHealthStore } from "../../stores/health-store.ts";
import { button, click, hasButton, mount, settle, text, typeInto, type Mounted } from "../../testing/dom.ts";
import { DEFAULT_FILTERS } from "./health-filters.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { HealthSection } from "./HealthSection.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  localStorage.clear();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useHealthStore.getState().reset();
});

const event = (over: Partial<HealthEvent> = {}): HealthEvent => ({
  seq: 9,
  ts: Date.now() - 60_000,
  kind: "feed",
  severity: "err",
  code: "not_a_feed",
  sourceRef: { kind: "trigger", id: "g1", name: "K8s Blog" },
  count: 1,
  ...over,
});

async function show(): Promise<Mounted & { readonly path: () => string }> {
  const root = createRootRoute({ component: () => <HealthSection /> });
  const route = (path: string) => createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([route("/"), route("/tasks"), route("/trigger/$id"), route("/agents/$id")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const page = await mount(<RouterProvider router={router} />);
  await settle();
  return { ...page, path: () => router.state.location.pathname };
}

const snap = (events: readonly HealthEvent[], hasMore = false): void =>
  bed.emitTo("subscribe.ops", { kind: "snapshot", events: [...events], hasMore });
const push = (frame: unknown): void => bed.emitTo("subscribe.ops", frame);

const rows = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")] as HTMLElement[];

describe("HealthSection", () => {
  it("renders a snapshot's rows: the time, the chip, the kind, the code, the sentence, the source link, ×N", async () => {
    const ts = Date.now() - 60_000;
    const page = await show();
    snap([event({ ts, count: 2 })]);
    await settle();
    const row = rows(page.container)[0] as HTMLElement;
    expect(row.textContent).toContain(
      new Intl.DateTimeFormat("en", { timeStyle: "medium", hourCycle: "h23" }).format(ts),
    );
    expect(row.querySelector('[data-slot="chip"]')?.textContent).toBe("ERR");
    expect(row.querySelector('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("err");
    expect(row.textContent).toContain("Feed");
    expect(row.textContent).toContain("not_a_feed");
    expect(row.textContent).toContain("The feed did not load: not a feed.");
    expect(row.querySelector('a[href="/trigger/g1"]')?.textContent).toBe("K8s Blog");
    expect(row.textContent).toContain("×2");
  });

  it("loads more with the oldest seq as `before`, and merges the page", async () => {
    bed.handlers["ops.events.list"] = (params) =>
      (params as { before?: number }).before === 7
        ? { events: [event({ seq: 5 })], hasMore: false }
        : { events: [], hasMore: false };
    const page = await show();
    snap([event({ seq: 9 }), event({ seq: 7 })], true);
    await settle();
    await click(button(page.container, "Load more"));
    await settle();
    expect(bed.called("ops.events.list").map((call) => call.params)).toEqual([{ before: 7 }]);
    expect(rows(page.container)).toHaveLength(3);
    expect(hasButton(page.container, "Load more")).toBe(false);
  });

  it("an empty snapshot shows the EmptyState and its action opens the tasks board", async () => {
    const page = await show();
    snap([]);
    await settle();
    expect(text(page.container)).toContain("No daemon failures recorded for this daemon run.");
    await click(button(page.container, "Open the tasks board"));
    await settle();
    expect(page.path()).toBe("/tasks");
  });

  it("a refused subscription shows the three-part copy, and Retry re-syncs", async () => {
    bed.handlers["subscribe.ops"] = () => {
      throw new RpcError("capacity");
    };
    const page = await show();
    await settle();
    expect(text(page.container)).toContain(
      "The failure list did not load. The daemon keeps running and the events are kept. Retry.",
    );
    delete bed.handlers["subscribe.ops"];
    await click(button(page.container, "Retry"));
    await settle();
    expect(bed.called("subscribe.ops")).toHaveLength(2);
    snap([event()]);
    await settle();
    expect(rows(page.container)).toHaveLength(1);
  });

  it("a collapse updates its row without a refetch", async () => {
    const page = await show();
    snap([event({ seq: 9, count: 1 })]);
    await settle();
    push({ kind: "collapse", seq: 9, ts: Date.now(), count: 5 });
    await settle();
    expect(rows(page.container)[0]?.textContent).toContain("×5");
    expect(bed.called("ops.events.list")).toHaveLength(0);
  });

  it("the Segmented switches kinds, a severity toggle dims its rows, and the search filters", async () => {
    const page = await show();
    snap([
      event(),
      event({ seq: 8, kind: "outbox", severity: "mut", code: "outbox_unknown_kinds", sourceRef: null }),
    ]);
    await settle();
    expect(rows(page.container)).toHaveLength(2);
    await click(button(page.container, "Outbox"));
    await settle();
    expect(rows(page.container)).toHaveLength(1);
    await click(button(page.container, "All"));
    await click(button(page.container, "MUT"));
    await settle();
    const mut = page.container.querySelector(
      'button[aria-pressed="false"] [data-slot="chip"][data-tone="mut"]',
    );
    expect(mut).not.toBeNull();
    expect(rows(page.container)).toHaveLength(1);
    await click(button(page.container, "MUT"));
    const field = page.container.querySelector("input") as HTMLInputElement;
    await typeInto(field, "k8s");
    await settle();
    expect(rows(page.container)).toHaveLength(1);
    await typeInto(field, "zzz");
    await settle();
    expect(rows(page.container)).toHaveLength(0);
  });

  it("a stored pap.health.filters restores the filters without an RPC", async () => {
    localStorage.setItem("pap.health.filters", JSON.stringify({ ...DEFAULT_FILTERS, kind: "sched" }));
    const page = await show();
    snap([event(), event({ seq: 8, kind: "sched", severity: "att", code: "missed" })]);
    await settle();
    expect(rows(page.container)).toHaveLength(1);
    expect(bed.called("ops.events.list")).toHaveLength(0);
  });

  it("announces a newly arrived err event politely, not the snapshot's own top", async () => {
    const page = await show();
    snap([event({ code: "feed_network", count: 1 })]);
    await settle();
    expect(page.container.querySelector('[aria-live="polite"]')?.textContent).toBe("");
    push({ kind: "event", event: event({ seq: 11, code: "not_a_feed" }) });
    await settle();
    expect(page.container.querySelector('[aria-live="polite"]')?.textContent).toBe("New failure: not_a_feed");
  });
});
