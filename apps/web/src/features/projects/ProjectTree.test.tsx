// @vitest-environment happy-dom
import type { ShellSession } from "@pap/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, mount, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import ProjectTree from "./ProjectTree.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
});
afterEach(() => vi.restoreAllMocks());

const HOUR = 3_600_000;
const load = (sessions: ShellSession[], patch: Parameters<typeof shellSnapshot>[1] = {}) =>
  act(async () => useShellStore.getState().apply(shellSnapshot(sessions, patch)));

async function show(onPick: (id: string) => void = () => {}, chord: string | null = "Ctrl+K") {
  const Tree = () => <ProjectTree onPick={onPick} chord={chord} />;
  const root = createRootRoute({ component: Tree });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const session = createRoute({ getParentRoute: () => root, path: "/s/$sessionId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, session]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const page = await mount(<RouterProvider router={router} />);
  await settle();
  return page.container;
}

const headings = (box: HTMLElement) => [...box.querySelectorAll("h3")].map((h) => h.textContent);
/** The shelf triggers (a heading cannot sit inside the Collapsible trigger button). */
const shelves = (box: HTMLElement) =>
  [...box.querySelectorAll("button[aria-expanded]")].map((b) => b.textContent);
const links = (box: HTMLElement) => [...box.querySelectorAll("a")].map((a) => a.getAttribute("href"));
const button = (box: HTMLElement, label: string) =>
  [...box.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;
const buttonStarting = (box: HTMLElement, label: string) =>
  [...box.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label)) as HTMLElement;

const archivedRow = (id: string, archivedAt: number) =>
  shellSession({ id, archivedAt, updatedAt: archivedAt });
const archivedPage = (page: number, size = 100) =>
  Array.from({ length: size }, (_, i) => archivedRow(`a${page}-${String(i).padStart(3, "0")}`, 1_000 - page));

describe("ProjectTree", () => {
  it("lists pinned, the projects in order, then the snoozed, settled and archived shelves", async () => {
    const now = Date.now();
    await load(
      [
        shellSession({ id: "pin", projectId: "b", pinRank: 1, updatedAt: now }),
        shellSession({ id: "in-a", projectId: "a", updatedAt: now }),
        shellSession({ id: "in-b", projectId: "b", updatedAt: now - 1 }),
        shellSession({ id: "zzz", projectId: "a", snoozedUntil: now + HOUR, updatedAt: now }),
        shellSession({ id: "done", projectId: "b", settledAt: now - 5, updatedAt: now - 5 }),
      ],
      {
        projects: [
          shellProject({ id: "a", name: "Alpha", position: 2, sessions: 2 }),
          shellProject({ id: "b", name: "Bravo", position: 1, sessions: 3 }),
        ],
        archived: 2,
      },
    );
    const box = await show();
    expect(headings(box)).toEqual(["Pinned", "Bravo", "Alpha"]);
    expect(shelves(box)).toEqual(["Snoozed (1)", "Settled (1)", "Archived (2)"]);
    expect(links(box)).toEqual(["/s/pin", "/s/in-b", "/s/in-a"]);
  });

  it("points a row at its session and tells onPick", async () => {
    await load([shellSession({ id: "one", name: "Fix login" })]);
    const picked: string[] = [];
    const box = await show((id) => picked.push(id));
    const row = box.querySelector<HTMLAnchorElement>("a");
    expect(row?.getAttribute("href")).toBe("/s/one");
    expect(row?.textContent).toContain("Fix login");
    await click(row as HTMLElement);
    expect(picked).toEqual(["one"]);
  });

  it("marks a running session Working and one that needs input Needs input", async () => {
    await load([
      shellSession({ id: "run", status: "running", updatedAt: 3 }),
      shellSession({ id: "ask", needsInput: true, updatedAt: 2 }),
      shellSession({ id: "idle", status: "idle", updatedAt: 1 }),
    ]);
    const box = await show();
    const chips = [...box.querySelectorAll("li")].map(
      (li) => li.querySelector('[data-slot="chip"]')?.textContent,
    );
    expect(chips).toEqual(["Working", "Needs input", undefined]);
  });

  it("shows 20 rows of a big project and reveals the rest with Show 20 more", async () => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      shellSession({ id: `s${i}`, projectId: "p", updatedAt: i }),
    );
    await load(sessions, { projects: [shellProject({ id: "p", name: "Big", sessions: 25 })] });
    const box = await show();
    expect(box.querySelectorAll("a")).toHaveLength(20);
    await click(button(box, "Show 20 more"));
    expect(box.querySelectorAll("a")).toHaveLength(25);
    expect(button(box, "Show 20 more")).toBeUndefined();
  });

  it.each([
    [40, "15 older sessions · search with Ctrl+K"],
    [26, "1 older session · search with Ctrl+K"],
  ])("says how many older sessions a project of %i has beyond the 25 held", async (total, line) => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      shellSession({ id: `s${i}`, projectId: "p", updatedAt: i }),
    );
    await load(sessions, { projects: [shellProject({ id: "p", name: "Big", sessions: total })] });
    const box = await show();
    expect(box.textContent).toContain(line);
  });

  it("names the palette when no chord is bound", async () => {
    await load([], { projects: [shellProject({ id: "p", name: "Far", sessions: 3 })] });
    const box = await show(() => {}, null);
    expect(box.textContent).toContain("3 older sessions · search with the palette");
  });

  it("keeps a project none of whose sessions the store holds, with its older line", async () => {
    await load([], { projects: [shellProject({ id: "p", name: "Far", sessions: 3 })] });
    const box = await show();
    expect(headings(box)).toEqual(["Far"]);
    expect(shelves(box)).toEqual([]);
    expect(box.textContent).toContain("3 older sessions · search with Ctrl+K");
  });

  it("filters, and says so when nothing matches", async () => {
    await load([shellSession({ id: "one", name: "Fix login" })]);
    const box = await show();
    await typeInto(box.querySelector("input") as HTMLInputElement, "zzz");
    expect(box.textContent).toContain("No session matches.");
    expect(box.querySelectorAll("a")).toHaveLength(0);
  });

  it("never spends a slot on an archived session in the projects", async () => {
    await load(
      [
        ...Array.from({ length: 3 }, (_, i) => archivedRow(`old${i}`, 100 + i)),
        shellSession({ id: "live", projectId: "p" }),
      ],
      { projects: [shellProject({ id: "p", name: "P", sessions: 1 })], archived: 3 },
    );
    const box = await show();
    expect(links(box)).toEqual(["/s/live"]);
  });

  it("names every shelf and flips aria-expanded on its native button trigger", async () => {
    const now = Date.now();
    await load([shellSession({ id: "z", snoozedUntil: now + HOUR, updatedAt: now })], { archived: 2 });
    const box = await show();
    const sections = [...box.querySelectorAll("section")].filter((one) =>
      one.querySelector("button[aria-expanded]"),
    );
    expect(sections).toHaveLength(2);
    for (const one of sections) {
      const label = one.getAttribute("aria-labelledby") ?? "";
      expect(one.querySelector(`[id="${label}"]`)?.textContent, label).toMatch(/^(Snoozed|Archived) \(\d\)$/);
    }
    const trigger = buttonStarting(box, "Snoozed");
    expect([trigger.tagName, trigger.getAttribute("aria-expanded")]).toEqual(["BUTTON", "false"]);
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("says archived sessions are not searched here while a filter is typed", async () => {
    await load([shellSession({ id: "one", name: "Fix" })], { archived: 2 });
    const box = await show();
    expect(box.textContent).not.toContain("not searched here");
    await typeInto(box.querySelector("input") as HTMLInputElement, "fix");
    expect(shelves(box)).toEqual([]);
    expect(box.textContent).toContain("Archived sessions are not searched here.");
  });

  it("renders a hostile name as text", async () => {
    await load([shellSession({ id: "x", name: "<img src=x onerror=alert(1)>" })]);
    const box = await show();
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("the Archived shelf", () => {
  const openShelf = async (box: HTMLElement) => {
    await click(buttonStarting(box, "Archived"));
    await settle();
  };

  it("lists the archive on first open, loads more from the last row's cursor", async () => {
    const first = [archivedRow("a1", 900), archivedRow("a2", 800)];
    const more = [archivedRow("a3", 700)];
    bed.handlers["sessions.listArchived"] = (params) =>
      (params as { before?: unknown }).before === undefined
        ? { sessions: first, hasMore: true }
        : { sessions: more, hasMore: false };
    await load([], { archived: 3 });
    const box = await show();
    expect(bed.called("sessions.listArchived")).toEqual([]);
    await openShelf(box);
    expect(bed.called("sessions.listArchived").map((c) => c.params)).toEqual([{}]);
    expect(links(box)).toEqual(["/s/a1", "/s/a2"]);
    await click(button(box, "Load more"));
    await settle();
    expect(bed.called("sessions.listArchived")[1]?.params).toEqual({ before: { archivedAt: 800, id: "a2" } });
    expect(links(box)).toEqual(["/s/a1", "/s/a2", "/s/a3"]);
    expect(button(box, "Load more")).toBeUndefined();
  });

  it("shows the error text with Retry, and Retry asks again", async () => {
    let calls = 0;
    bed.handlers["sessions.listArchived"] = () => {
      if (++calls === 1) throw new RpcError("capacity");
      return { sessions: [archivedRow("a1", 900)], hasMore: false };
    };
    await load([], { archived: 1 });
    const box = await show();
    await openShelf(box);
    expect(box.textContent).toContain("The server is at capacity. Try again later.");
    await click(button(box, "Retry"));
    await settle();
    expect(bed.called("sessions.listArchived")).toHaveLength(2);
    expect(links(box)).toEqual(["/s/a1"]);
    expect(box.textContent).not.toContain("The server is at capacity.");
  });

  it("stops at 500 rows: no Load more, the cap line, and no sixth request (RT-35)", async () => {
    let page = 0;
    bed.handlers["sessions.listArchived"] = () => ({ sessions: archivedPage(page++), hasMore: true });
    await load([], { archived: 900 });
    const box = await show();
    await openShelf(box);
    for (let i = 0; i < 4; i++) {
      await click(button(box, "Load more"));
      await settle();
    }
    expect(box.querySelectorAll("a")).toHaveLength(500);
    expect(button(box, "Load more")).toBeUndefined();
    expect(box.textContent).toContain("Only the 500 most recent are listed · search with Ctrl+K");
    expect(bed.called("sessions.listArchived")).toHaveLength(5);
  });

  it("cuts a page that overshoots 500: exactly 500 rows, the cap line, none of the tail", async () => {
    let page = 0;
    bed.handlers["sessions.listArchived"] = () => ({
      sessions: archivedPage(page++, page === 5 ? 150 : 100),
      hasMore: true,
    });
    await load([], { archived: 900 });
    const box = await show();
    await openShelf(box);
    for (let i = 0; i < 4; i++) {
      await click(button(box, "Load more"));
      await settle();
    }
    expect(box.querySelectorAll("a")).toHaveLength(500);
    expect(box.querySelector('a[href="/s/a4-120"]')).toBeNull();
    expect(box.textContent).toContain("Only the 500 most recent are listed");
  });

  it("sends one request for two clicks on Load more before the page lands", async () => {
    let release: (value: unknown) => void = () => {};
    let calls = 0;
    bed.handlers["sessions.listArchived"] = () =>
      ++calls === 1
        ? { sessions: archivedPage(0, 2), hasMore: true }
        : new Promise((resolve) => (release = resolve));
    await load([], { archived: 5 });
    const box = await show();
    await openShelf(box);
    const more = button(box, "Load more");
    await act(async () => {
      more.click();
      more.click();
    });
    expect(bed.called("sessions.listArchived")).toHaveLength(2);
    await act(async () => release({ sessions: [], hasMore: false }));
  });

  it("asks the archive once however often the shelf is closed and reopened", async () => {
    bed.handlers["sessions.listArchived"] = () => ({ sessions: [archivedRow("a1", 900)], hasMore: false });
    await load([], { archived: 1 });
    const box = await show();
    await openShelf(box);
    await click(buttonStarting(box, "Archived"));
    await click(buttonStarting(box, "Archived"));
    await settle();
    expect(links(box)).toEqual(["/s/a1"]);
    expect(bed.called("sessions.listArchived")).toHaveLength(1);
  });

  it("drops a row the store now reports as not archived (RT-35)", async () => {
    const rows = [archivedRow("a1", 900), archivedRow("a2", 800)];
    bed.handlers["sessions.listArchived"] = () => ({ sessions: rows, hasMore: false });
    await load(rows, { archived: 2 });
    const box = await show();
    await openShelf(box);
    expect(links(box)).toEqual(["/s/a1", "/s/a2"]);
    await act(async () =>
      useShellStore.getState().apply({ kind: "session", session: { ...rows[0], archivedAt: null } }),
    );
    expect(links(box).filter((href) => href === "/s/a1")).toEqual(["/s/a1"]); // now in the project list
    expect(box.querySelector('[data-shelf="archived"] a[href="/s/a1"]')).toBeNull();
    expect(box.querySelector('[data-shelf="archived"] a[href="/s/a2"]')).not.toBeNull();
  });
});

describe("the tree when the stream fails", () => {
  it("says so with the error text and Retry, shows no spinner, and Retry asks the stream again", async () => {
    bed.runtime.subscriptions.subscribe("shell", "me", () => {});
    await settle();
    expect(bed.called("subscribe.shell")).toHaveLength(1);
    await act(async () => useShellStore.getState().fail("capacity"));
    const box = await show();
    expect(box.textContent).toContain("The session list could not be loaded.");
    expect(box.textContent).toContain("The server is at capacity. Try again later.");
    expect(box.querySelector('[data-slot="spinner"]')).toBeNull();
    await click(button(box, "Retry"));
    await settle();
    const asks = bed.called("subscribe.shell");
    expect(asks).toHaveLength(2);
    expect(asks[1]?.params).toEqual({});
  });

  it("says the list could not be read when the snapshot was unreadable", async () => {
    await act(async () => useShellStore.getState().apply({ kind: "snapshot" }));
    const box = await show();
    expect(box.textContent).toContain("The session list could not be read. Reload the page.");
  });
});
