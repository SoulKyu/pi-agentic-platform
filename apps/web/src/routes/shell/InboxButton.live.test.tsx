// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { mount, type Mounted } from "../../testing/dom.ts";
import { InboxButton } from "./InboxButton.tsx";

let page: Mounted | null = null;
beforeEach(async () => {
  useInboxStore.getState().reset();
  page = await mount(
    <TooltipProvider>
      <InboxButton shortcut={["Mod", "I"]} joiner="+" />
    </TooltipProvider>,
  );
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  useInboxStore.getState().reset();
  setLocale("en");
});

const live = () => page?.container.querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
const send = (event: unknown) => act(async () => useInboxStore.getState().apply(event));
const snapshot = (toHandle: number) => ({
  kind: "snapshot",
  items: [],
  unread: toHandle,
  toHandle,
  truncated: false,
});

describe("the Inbox button's live region", () => {
  it("is a polite status region that is there before anything is said", () => {
    expect(live()).not.toBeNull();
    expect(live()?.textContent).toBe("");
    expect(live()?.className).toContain("sr-only");
  });

  it("stays quiet for the first snapshot, whatever it holds", async () => {
    await send(snapshot(2));
    expect(live()?.textContent).toBe("");
  });

  it("announces a question that arrives, with the count", async () => {
    await send(snapshot(1));
    await send({ kind: "counts", unread: 2, toHandle: 2 });
    expect(live()?.textContent).toBe("A new question is waiting for you. 2 to handle.");
  });

  it("does not announce a refresh that changes nothing, or a count that goes down", async () => {
    await send(snapshot(2));
    await send({ kind: "counts", unread: 2, toHandle: 3 });
    expect(live()?.textContent).not.toBe("");
    await send({ kind: "counts", unread: 2, toHandle: 1 });
    expect(live()?.textContent).toBe("");
    await send({ kind: "counts", unread: 2, toHandle: 1 });
    await send(snapshot(1));
    expect(live()?.textContent).toBe("");
  });

  it("speaks French", async () => {
    setLocale("fr");
    await send(snapshot(0));
    await send({ kind: "counts", unread: 1, toHandle: 1 });
    expect(live()?.textContent).toBe("Une nouvelle question vous attend. 1 à traiter.");
  });
});
