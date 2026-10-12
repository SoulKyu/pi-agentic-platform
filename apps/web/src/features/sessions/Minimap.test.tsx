// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import { click, mount, type Mounted } from "../../testing/dom.ts";
import { act, useState } from "react";
import { Minimap } from "./Minimap.tsx";
import { rowId } from "./minimap.vm.ts";
import type { TranscriptItem } from "./transcript.vm.ts";

const user = (key: string, text: string): TranscriptItem => ({
  kind: "message",
  key,
  author: "you",
  text,
  thinking: "",
  entryId: key,
});
const viewWith = (history: Partial<SessionView["history"]>): SessionView => ({
  ...EMPTY_VIEW,
  history: { ...EMPTY_VIEW.history, ...history },
});

interface Fake {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}
const observers: Fake[] = [];
const see = (visible: Element[]) => {
  for (const fake of observers.filter((candidate) => !candidate.disconnected)) {
    fake.callback(
      fake.observed.map((target) => ({ target, isIntersecting: visible.includes(target) })) as never,
      {} as IntersectionObserver,
    );
  }
};

function Page({
  scope,
  items,
  view = EMPTY_VIEW,
  onLoadOlder = () => {},
}: {
  scope: string;
  items: readonly TranscriptItem[];
  view?: SessionView;
  onLoadOlder?: () => void;
}) {
  return (
    <>
      <ol>
        {items.map((item) => (
          <li key={item.key} id={rowId(scope, item.key)} />
        ))}
      </ol>
      <Minimap scope={scope} items={items} view={view} onLoadOlder={onLoadOlder} />
    </>
  );
}

function Grows() {
  const [items, setItems] = useState([user("u1", "one")]);
  return (
    <>
      <button data-add onClick={() => setItems([...items, user("u2", "two")])} />
      <Page scope="s" items={items} />
    </>
  );
}

let page: Mounted | null = null;
let reduced = false;
beforeEach(() => {
  observers.length = 0;
  reduced = false;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly record: Fake = { callback: undefined as never, observed: [], disconnected: false };
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
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query === "(prefers-reduced-motion: reduce)",
  }));
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

const turnButton = (container: ParentNode, name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) as HTMLElement;

describe("Minimap", () => {
  it("names each turn button by its number and preview, with no native title and no markup", async () => {
    const items = [user("u5", "Fix the login please"), user("u6", "**bold** <b>x</b>")];
    page = await mount(<Page scope="s" items={items} view={viewWith({ turnsBefore: 4 })} />);
    const first = turnButton(page.container, "Turn 5: Fix the login please");
    expect(first.textContent).toBe("5");
    const second = turnButton(page.container, "Turn 6: **bold** <b>x</b>");
    expect(second.querySelector("b")).toBeNull();
    expect(page.container.querySelector("[title]")).toBeNull();
    const rail = page.container.querySelector("nav");
    expect(rail?.getAttribute("aria-label")).toBe("Turns");
    expect(rail?.className).toContain("hidden");
    expect(rail?.className).toContain("md:flex");
  });

  it("scrolls the row of a turn into view, smoothly unless reduced motion is asked for, and keeps focus", async () => {
    const items = [user("u5", "hello"), user("a:b#1.2", "dotted key")];
    page = await mount(<Page scope=":r1:" items={items} view={viewWith({ turnsBefore: 4 })} />);
    const target = document.getElementById(rowId(":r1:", "a:b#1.2")) as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const control = turnButton(page.container, "Turn 6: dotted key");
    control.focus();
    await click(control);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.activeElement).toBe(control);
    reduced = true;
    await click(control);
    expect(scroll).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
  });

  it("keeps ids unique when two screens are mounted", async () => {
    const items = [user("u5", "same")];
    page = await mount(
      <>
        <Page scope="one" items={items} />
        <Page scope="two" items={items} />
      </>,
    );
    const ids = [...page.container.querySelectorAll("li")].map((li) => li.id);
    expect(ids).toEqual(["row-one-u5", "row-two-u5"]);
  });

  it("marks the turn in view with aria-current, and keeps it when none is visible", async () => {
    const items = [user("u1", "one"), user("u2", "two")];
    page = await mount(<Page scope="s" items={items} />);
    const rows = items.map((item) => document.getElementById(rowId("s", item.key)) as HTMLElement);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual(rows);
    await act(async () => see([rows[1] as HTMLElement]));
    expect(turnButton(page.container, "Turn 2: two").getAttribute("aria-current")).toBe("true");
    expect(page.container.querySelectorAll("[aria-current]")).toHaveLength(1);
    await act(async () => see([]));
    expect(turnButton(page.container, "Turn 2: two").getAttribute("aria-current")).toBe("true");
    await act(async () => see(rows));
    expect(turnButton(page.container, "Turn 1: one").getAttribute("aria-current")).toBe("true");
    expect(page.container.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("disconnects its observer when the turns change, observing the new rows, and when it unmounts", async () => {
    page = await mount(<Grows />);
    expect(observers.map((o) => o.disconnected)).toEqual([false]);
    await click(page.container.querySelector("[data-add]") as Element);
    expect(observers.map((o) => o.disconnected)).toEqual([true, false]);
    expect(observers[1]?.observed).toHaveLength(2);
    await page.unmount();
    page = null;
    expect(observers.map((o) => o.disconnected)).toEqual([true, true]);
  });

  it("offers the earlier turns through the transcript's own loader, only while more remain", async () => {
    const onLoadOlder = vi.fn();
    const items = [user("u5", "hello")];
    const view = viewWith({ hasMore: true, oldestEntryId: "u5", turnsBefore: 4 });
    page = await mount(<Page scope="s" items={items} view={view} onLoadOlder={onLoadOlder} />);
    const more = [...page.container.querySelectorAll("button")].find(
      (b) => b.textContent === "4 earlier turns",
    );
    await click(more as Element);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await page.unmount();
    page = await mount(<Page scope="s" items={items} view={viewWith({ turnsBefore: 4 })} />);
    expect(page.container.textContent).not.toContain("earlier");
  });
});
