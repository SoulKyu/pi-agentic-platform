// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/register-sidebar.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useFocusEntry } from "../../stores/focus-entry.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
const row = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});
function Live({ id }: { id: string }) {
  const view = useSessionStore((state) => state.views[id]) ?? EMPTY_VIEW;
  return <Transcript sessionId={id} view={view} toolDetail="expanded" />;
}
const scrolled: Element[] = [];

beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
  useFocusEntry.setState({ target: null });
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

async function show(hasMore: boolean) {
  useSessionStore.getState().apply(
    "s1",
    sessionSnapshot({
      rows: [row("e1", "first question"), row("e2", "second question")],
      history: { hasMore, oldestEntryId: "e1", turnsBefore: 0 },
    }),
  );
  page = await mount(<Live id="s1" />);
  await settle();
  return page.container;
}

describe("Transcript focus entry", () => {
  it("scrolls the asked row into view, focuses it, and takes the target once", async () => {
    useFocusEntry.getState().ask({ sessionId: "s1", entryId: "e2" });
    const container = await show(false);
    const target = [...container.querySelectorAll("[id^='row-']")].find((el) =>
      el.textContent?.includes("second question"),
    );
    expect(scrolled).toEqual([target]);
    expect(document.activeElement).toBe(target);
    expect(useFocusEntry.getState().target).toBeNull();
    expect(text(container)).not.toContain("older messages");
    await page?.rerender(<Live id="s1" />);
    expect(scrolled).toHaveLength(1);
  });

  it("leaves a target for another session alone", async () => {
    useFocusEntry.getState().ask({ sessionId: "other", entryId: "e2" });
    await show(false);
    expect(scrolled).toEqual([]);
    expect(useFocusEntry.getState().target).toEqual({ sessionId: "other", entryId: "e2" });
  });

  it("says the match is in older messages when the entry is not loaded and more remain", async () => {
    useFocusEntry.getState().ask({ sessionId: "s1", entryId: "e0" });
    const container = await show(true);
    expect(scrolled).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "The match is in older messages. Use Load older messages.",
    );
    expect(useFocusEntry.getState().target).toBeNull();
  });
});
