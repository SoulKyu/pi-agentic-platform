// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { itemOf } from "../../features/inbox/inbox-bed.tsx";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement: h } = await import("react");
  return { HomePane: () => h("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) => h("p", { "data-stub": "session" }, sessionId),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["inbox.markRead"] = () => ({ updated: 1 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([shellSession({ id: "one", cwd: "/w/api" })]));
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  useInboxStore.getState().reset();
  setLocale("en");
  vi.unstubAllGlobals();
});

const ITEMS = [
  itemOf({ id: "q1", sessionId: "one", triggerName: "prod-alerts" }),
  itemOf({ id: "q2", sessionId: "two", triggerName: "nightly", createdAt: itemOf().createdAt - 1 }),
  itemOf({ id: "d1", kind: "task_done", toHandle: false, triggerName: "feed" }),
];

const deliver = (items = ITEMS) =>
  vi.waitFor(
    () =>
      bed.emitTo("subscribe.inbox", {
        kind: "snapshot",
        items,
        unread: items.length,
        toHandle: items.filter((item) => item.toHandle).length,
        truncated: false,
      }),
    { timeout: 2_000 },
  );

/** What a screen reader says: the text outside aria-hidden, in order, with spaces normalised. */
function accessibleText(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return;
    if (node.nodeType === 3) parts.push(node.textContent ?? "");
    node.childNodes.forEach(walk);
  };
  walk(element);
  return parts.join("").replace(/\s+/g, " ").trim();
}
const inboxTab = (container: ParentNode) =>
  container.querySelectorAll<HTMLElement>('nav[aria-label="Sections"] button')[3] as HTMLElement;

describe("the phone's Inbox", () => {
  it("counts the questions to handle in the bottom nav, not the unread items, and says what it counts", async () => {
    const page = await renderShell("/", { phone: true });
    await deliver();
    await vi.waitFor(() => expect(accessibleText(inboxTab(page.container))).toBe("Inbox 2 to handle"));
    expect(inboxTab(page.container).querySelector('[data-slot="badge"]')?.textContent).toContain("2");
    setLocale("fr");
    await settle();
    expect(accessibleText(inboxTab(page.container))).toBe("Boîte 2 à traiter");
    await page.unmount();
  });

  it("shows no badge when nothing is to handle", async () => {
    const page = await renderShell("/", { phone: true });
    await deliver([ITEMS[2] as (typeof ITEMS)[number]]);
    await vi.waitFor(() => expect(useInboxStore.getState().view.loaded).toBe(true));
    expect(inboxTab(page.container).querySelector('[data-slot="badge"]')).toBeNull();
    await page.unmount();
  });

  it("shows the panel in the Inbox section, and opens a row's session in the Work section", async () => {
    const page = await renderShell("/", { phone: true });
    await deliver();
    await click(inboxTab(page.container));
    await vi.waitFor(() => expect(page.container.querySelector("[data-inbox-panel]")).not.toBeNull(), {
      timeout: 2_000,
    });
    const rows = [...page.container.querySelectorAll<HTMLElement>('[data-slot="inbox-row"]')];
    expect(rows.map((row) => row.dataset["itemId"])).toEqual(["q1", "q2", "d1"]);
    await click(rows[0] as HTMLElement);
    await vi.waitFor(
      () => expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("one"),
      {
        timeout: 2_000,
      },
    );
    expect(bed.called("inbox.markRead")[0]?.params).toEqual({ ids: ["q1"] });
    expect(page.container.querySelector("[data-inbox-panel]")).toBeNull();
    // The URL names the active item, so a reload lands on the row's session.
    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe("/s/one"));
    await page.unmount();
  });
});
