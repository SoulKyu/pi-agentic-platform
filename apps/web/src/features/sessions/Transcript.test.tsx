// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW, reduceSession } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { alerts, button, click, hasButton, mount, settle, text, type Mounted } from "../../testing/dom.ts";
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
const older = (hasMore: boolean) => ({
  rows: [row("e1", "older question")],
  hasMore,
  oldestEntryId: "e1",
  turnsBefore: 0,
});

function Live({ id }: { id: string }) {
  const view = useSessionStore((state) => state.views[id]) ?? EMPTY_VIEW;
  return <Transcript sessionId={id} view={view} />;
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

const observers: Array<{
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}> = [];
const intersect = (isIntersecting: boolean) => {
  const live = observers.filter((observer) => !observer.disconnected);
  for (const observer of live)
    observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
};

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly record = {
        callback: undefined as unknown as IntersectionObserverCallback,
        observed: [] as Element[],
        disconnected: false,
      };
      constructor(callback: IntersectionObserverCallback) {
        this.record.callback = callback;
        observers.push(this.record);
      }
      observe(element: Element) {
        this.record.observed.push(element);
      }
      disconnect() {
        this.record.disconnected = true;
      }
      unobserve() {}
    },
  );
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

describe("Transcript older history", () => {
  it("loads older messages above, once per click, and drops the button when nothing more remains", async () => {
    bed.handlers["sessions.history"] = () => older(false);
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    await click(button(container, "Load older messages"));
    await settle();
    expect(bed.called("sessions.history")).toEqual([
      { method: "sessions.history", params: { sessionId: "sess-1", before: "e5" } },
    ]);
    expect(text(container).indexOf("older question")).toBeLessThan(text(container).indexOf("newest"));
    expect(hasButton(container, "Load older messages")).toBe(false);
  });

  it("keeps the button while more remain", async () => {
    bed.handlers["sessions.history"] = () => older(true);
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    await click(button(container, "Load older messages"));
    await settle();
    expect(hasButton(container, "Load older messages")).toBe(true);
  });

  it("allows one request at a time: a second click, and the sentinel, wait for the first", async () => {
    let answer: (page: unknown) => void = () => {};
    bed.handlers["sessions.history"] = () => new Promise((resolve) => (answer = resolve));
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    await click(button(container, "Load older messages"));
    await click(button(container, "Load older messages"));
    intersect(true);
    intersect(true);
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(1);
    answer(older(false));
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(1);
    expect(text(container)).toContain("older question");
  });

  it("asks when the sentinel scrolls into view, and not when it leaves", async () => {
    bed.handlers["sessions.history"] = () => older(false);
    await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    intersect(false);
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(0);
    intersect(true);
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(1);
  });

  it("does not loop-fire after a failed page: the sentinel stays quiet until the button is pressed", async () => {
    let tries = 0;
    bed.handlers["sessions.history"] = () => {
      if (++tries === 1) throw new RpcError("internal");
      return older(false);
    };
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    intersect(true);
    await settle();
    intersect(true);
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(1);
    expect(alerts(container)).toContain("Something went wrong.");
    await click(button(container, "Load older messages"));
    await settle();
    expect(bed.called("sessions.history")).toHaveLength(2);
    expect(alerts(container)).toEqual([]);
  });

  it("drops a page that lands after the view moved to another branch (M2-RT-12)", async () => {
    let answer: (page: unknown) => void = () => {};
    bed.handlers["sessions.history"] = () => new Promise((resolve) => (answer = resolve));
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    await click(button(container, "Load older messages"));
    await emit(snapshotOf({ rows: [row("e9", "other branch")], history: cursor("e9") }));
    answer(older(false));
    await settle();
    expect(text(container)).toContain("other branch");
    expect(text(container)).not.toContain("older question");
    expect(hasButton(container, "Load older messages")).toBe(true);
  });

  it("shows the error of a failed page and keeps the button", async () => {
    bed.handlers["sessions.history"] = () => {
      throw new RpcError("internal");
    };
    const container = await show({ rows: [row("e5", "newest")], history: cursor("e5") });
    await click(button(container, "Load older messages"));
    await settle();
    expect(alerts(container)).toContain("Something went wrong.");
    expect(hasButton(container, "Load older messages")).toBe(true);
  });

  it("offers no button when there is nothing above, or no cursor to ask from", async () => {
    const container = await show({ rows: [row("e5", "newest")] });
    expect(hasButton(container, "Load older messages")).toBe(false);
    await emit(
      snapshotOf({
        rows: [row("e5", "newest")],
        history: { hasMore: true, oldestEntryId: null, turnsBefore: 1 },
      }),
    );
    expect(hasButton(container, "Load older messages")).toBe(false);
  });
});

describe("Transcript rows", () => {
  it("renders untrusted text as text: no element from message, thinking, summary or tool text", async () => {
    const bad = '<img src=x onerror="alert(1)">';
    const container = await show({
      rows: [
        {
          entryId: "e1",
          message: { role: "compactionSummary", summary: bad, tokensBefore: 5, timestamp: 1 },
        },
        {
          entryId: "e2",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: bad },
              { type: "text", text: bad },
              { type: "toolCall", id: "c", name: bad, arguments: { command: bad } },
            ],
            timestamp: 2,
          },
        },
        {
          entryId: "e3",
          message: {
            role: "toolResult",
            toolCallId: "c",
            content: [{ type: "text", text: bad }],
            timestamp: 3,
          },
        },
      ],
    });
    expect(container.querySelector("img")).toBeNull();
    expect(text(container).split(bad).length - 1).toBeGreaterThanOrEqual(4);
  });

  it("shows thinking and a compaction summary collapsed in native details", async () => {
    const container = await show({
      rows: [
        {
          entryId: "e1",
          message: { role: "compactionSummary", summary: "earlier work", tokensBefore: 900, timestamp: 1 },
        },
        {
          entryId: "e2",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "Hi" },
            ],
            timestamp: 2,
          },
        },
      ],
    });
    const details = [...container.querySelectorAll("details")];
    expect(details.map((d) => [d.open, d.querySelector("summary")?.textContent])).toEqual([
      [false, "Conversation compacted · from 900 tokens"],
      [false, "Thinking"],
    ]);
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("says when the session is compacting or retrying", async () => {
    const container = await show({ rows: [row("e1", "hi")] });
    await emit({ kind: "activity", activity: { compacting: true, retry: null } });
    expect(text(container)).toContain("Compacting…");
    await emit({ kind: "activity", activity: { compacting: false, retry: { attempt: 2, maxAttempts: 3 } } });
    expect(text(container)).toContain("Retrying (2/3)…");
    expect(text(container)).not.toContain("Compacting…");
    await emit({ kind: "activity", activity: { compacting: false, retry: null } });
    expect(text(container)).not.toContain("Retrying");
  });

  it("keeps the view model and the screen in step with a snapshot the reducer made", () => {
    expect(reduceSession(EMPTY_VIEW, snapshotOf({})).loaded).toBe(true);
  });
});

describe("Transcript scroll position", () => {
  // happy-dom has no layout: a row is 100 px tall, and scrollTop is a plain number kept per element.
  const tops = new WeakMap<Element, number>();
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.children.length * 100;
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
    expect(list.children.length).toBe(5);
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
