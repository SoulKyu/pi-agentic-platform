// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { settle, type Mounted } from "../../testing/dom.ts";
import { current, itemOf, loadInbox, newBed, show } from "./inbox-bed.tsx";
import InboxPanel from "./InboxPanel.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
const scrolled: string[] = [];
beforeEach(() => {
  newBed();
  setLocale("en");
  useInboxReveal.getState().clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-item-id") ?? "");
  };
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  useInboxStore.getState().reset();
  useInboxReveal.getState().clear();
});

const ITEMS = [
  itemOf({ id: "q1" }),
  itemOf({ id: "q2", createdAt: 1 }),
  itemOf({ id: "d1", toHandle: false }),
];

describe("InboxPanel revealing an item a notification named", () => {
  it("scrolls the row into view, focuses it, and forgets the request", async () => {
    loadInbox(ITEMS);
    useInboxReveal.getState().ask("q2");
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await settle();
    expect(scrolled).toEqual(["q2"]);
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-item-id")).toBe("q2");
    expect(useInboxReveal.getState().itemId).toBeNull();
  });

  it("waits for the item when the snapshot has not come yet", async () => {
    useInboxStore.getState().reset();
    useInboxReveal.getState().ask("q1");
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await settle();
    expect(scrolled).toEqual([]);
    expect(useInboxReveal.getState().itemId).toBe("q1");
    await act(async () => loadInbox(ITEMS));
    await settle();
    expect(scrolled).toEqual(["q1"]);
  });

  it("does nothing when no item was named, or the item is not in the list", async () => {
    loadInbox(ITEMS);
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await settle();
    expect(scrolled).toEqual([]);
    useInboxReveal.getState().ask("not-there");
    await settle();
    expect(scrolled).toEqual([]);
  });

  it("does not interpret the id as a selector", async () => {
    loadInbox([...ITEMS, itemOf({ id: 'a"],[x' })]);
    useInboxReveal.getState().ask('a"],[x');
    page = await show(<InboxPanel onOpenSession={() => {}} />);
    await settle();
    expect(scrolled).toEqual(['a"],[x']);
  });
});
