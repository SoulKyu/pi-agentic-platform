// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, mount, settle, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
const row = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});
const cursor = (oldestEntryId: string) => ({ hasMore: true, oldestEntryId, turnsBefore: 2 });

function Live({ id }: { id: string }) {
  const view = useSessionStore((state) => state.views[id]) ?? EMPTY_VIEW;
  return <Transcript sessionId={id} view={view} toolDetail="expanded" />;
}
function snapshotOf(patch: Record<string, unknown>) {
  return sessionSnapshot(patch);
}
async function show(patch: Record<string, unknown>) {
  useSessionStore.getState().apply("sess-1", snapshotOf(patch));
  page = await mount(<Live id="sess-1" />);
  await settle();
  return page.container;
}
async function emit(event: unknown) {
  useSessionStore.getState().apply("sess-1", event);
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("Transcript scroll position", () => {
  // happy-dom has no layout: a row is 100 px tall, and scrollTop is a plain number kept per element.
  const tops = new WeakMap<Element, number>();
  // A row is a `[id^='row-']` element (rows of one author share an item), and so is the "load older" item.
  const rowsIn = (list: HTMLElement) =>
    list.querySelectorAll("[id^='row-']").length +
    [...list.children].filter((item) => item.querySelector("[id^='row-']") === null).length;
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return rowsIn(this) * 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        tops.set(this, value);
      },
    });
  });
  afterEach(() => {
    // The stand-ins above are own properties of the prototype: removing them brings back happy-dom's.
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  });
  const threeOlder = () => ({
    rows: [row("e2", "two"), row("e3", "three"), row("e4", "four")],
    hasMore: true,
    oldestEntryId: "e2",
    turnsBefore: 1,
  });
  const scrolledTo = async (container: HTMLElement, top: number) => {
    const list = container.querySelector("ol") as HTMLElement;
    tops.set(list, top);
    await act(async () => {
      list.dispatchEvent(new Event("scroll"));
    });
    return list;
  };

  it("keeps the reader on the same row when older rows land above", async () => {
    bed.handlers["sessions.history"] = threeOlder;
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    const list = await scrolledTo(container, 40);
    await click(button(container, "Load older messages"));
    await settle();
    expect(rowsIn(list)).toBe(5);
    expect(list.scrollTop).toBe(340);
  });

  it("does not shift the reader later when the page was dropped", async () => {
    let answer: (page: unknown) => void = () => {};
    bed.handlers["sessions.history"] = () => new Promise((resolve) => (answer = resolve));
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    const list = await scrolledTo(container, 40);
    await click(button(container, "Load older messages"));
    await emit(snapshotOf({ rows: [row("e9", "other branch")], history: cursor("e9") }));
    answer(threeOlder());
    await settle();
    await emit({
      kind: "pi",
      event: { type: "message_end", message: { role: "user", content: "later", timestamp: 99 } },
    });
    expect(list.scrollTop).toBe(40);
  });

  it("lets go of the anchor when an accepted page adds no row and moves no cursor", async () => {
    bed.handlers["sessions.history"] = () => ({
      rows: [row("e5", "newest")],
      hasMore: true,
      oldestEntryId: "e5",
      turnsBefore: 2,
    });
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    const list = await scrolledTo(container, 40);
    await click(button(container, "Load older messages"));
    await settle();
    await emit({
      kind: "pi",
      event: { type: "message_end", message: { role: "user", content: "later", timestamp: 99 } },
    });
    expect(list.scrollTop).toBe(40);
  });

  it("follows the end for a reader who is at the bottom", async () => {
    const container = await show({ rows: [row("e5", "newest")] });
    const list = container.querySelector("ol") as HTMLElement;
    await emit({
      kind: "pi",
      event: { type: "message_end", message: { role: "user", content: "next", timestamp: 99 } },
    });
    expect(list.scrollTop).toBe(200);
  });
});
