// @vitest-environment happy-dom
import type { OverviewSnapshot } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { button, click, hasButton, mount, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { OverviewCallbacks } from "./callbacks.ts";
import { NOW, box, ownerSnapshot } from "./overview-fixtures.ts";
import { OverviewPane } from "./OverviewPane.tsx";
import { callbacks, cards, showIn } from "./overview-bed.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const show = (snapshot: OverviewSnapshot, on: OverviewCallbacks = callbacks()) => showIn(bed, snapshot, on);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  setLocale("en");
  useLaunchStore.getState().reset();
  vi.useRealTimers();
});

describe("OverviewPane: the cards", () => {
  it("keeps the snapshot's order", async () => {
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({ ref: { kind: "agent", id: "b-agent" }, name: "Zed", state: "waiting" }),
          box({ ref: { kind: "project", id: "a-proj" }, name: "Alpha", state: "running" }),
        ],
      }),
    );
    expect(cards(root).map((card) => card.getAttribute("data-box-card"))).toEqual([
      "agent:b-agent",
      "project:a-proj",
    ]);
  });

  it("a waiting card shows its category word, its detail and ANSWER, which reveals the Inbox item", async () => {
    const item = {
      id: "i1",
      kind: "task_needs_input",
      toHandle: true,
      taskId: "t1",
      sessionId: null,
      triggerName: "Nightly",
      costUsd: null,
      createdAt: 1,
      readAt: null,
      resolvedAt: null,
      resolution: null,
      agentId: null,
      refId: null,
      entryId: null,
      detail: "Which branch?",
    } as const;
    const on = callbacks();
    const root = await show(
      ownerSnapshot({ boxes: [box({ state: "waiting", ask: { source: "inbox", item } })] }),
      on,
    );
    const card = cards(root)[0] as HTMLElement;
    expect(text(card)).toContain("Input needed");
    expect(text(card)).toContain("Which branch?");
    expect(card.className).toContain("border-attn-line");
    await click(button(card, "Answer"));
    expect(on.revealInbox).toHaveBeenCalledWith("i1");
  });

  it("a session dialog says where it waits and opens that session", async () => {
    const on = callbacks();
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({
            ref: { kind: "project", id: "p1" },
            state: "waiting",
            ask: { source: "session", sessionId: "s7", title: "Fix bug" },
          }),
        ],
      }),
      on,
    );
    expect(text(cards(root)[0] as Element)).toContain("Waiting in this session");
    expect(text(cards(root)[0] as Element)).toContain("Fix bug");
    await click(button(root, "Answer"));
    expect(on.openSession).toHaveBeenCalledWith("s7");
  });

  it("a host card says Project on this host and no box, and has no phase chip", async () => {
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({ ref: { kind: "host", id: "h1" }, name: "Local", phase: null, needMb: 0, reservedMb: 0 }),
        ],
      }),
    );
    const card = cards(root)[0] as HTMLElement;
    expect(text(card)).toContain("Project on this host");
    expect(text(card)).toContain("no box");
    expect(card.querySelector("[data-phase]")).toBeNull();
  });

  it("a box card shows its phase", async () => {
    const root = await show(ownerSnapshot({ boxes: [box({ phase: "paused" })] }));
    expect(cards(root)[0]?.querySelector("[data-phase]")?.textContent).toBe("Paused");
  });

  it("lists activities, with no empty segment for an unnamed thread, and +N more", async () => {
    const since = NOW - 5 * 60_000;
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({
            activities: [
              { kind: "thread", id: "s1", title: "", since, stoppable: false },
              { kind: "task", id: "t1", title: "Tidy", since, stoppable: true },
            ],
            more: 2,
          }),
        ],
      }),
    );
    const card = text(cards(root)[0] as Element);
    const time = `${String(new Date(since).getHours()).padStart(2, "0")}:${String(new Date(since).getMinutes()).padStart(2, "0")}`;
    expect(card).toContain(`Thread · since ${time}`);
    expect(card).toContain(`Task · Tidy · since ${time}`);
    expect(card).toContain("+2 more");
    expect(card).not.toContain("·  ·");
  });

  it("activities open their session or task", async () => {
    const on = callbacks();
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({
            activities: [
              { kind: "session", id: "s1", title: "Fix", since: null, stoppable: false },
              { kind: "task", id: "t1", title: "Tidy", since: null, stoppable: true },
            ],
          }),
        ],
      }),
      on,
    );
    await click(button(root, "Session · Fix"));
    await click(button(root, "Task · Tidy"));
    expect(on.openSession).toHaveBeenCalledWith("s1");
    expect(on.openTask).toHaveBeenCalledWith("t1");
  });

  it("the name opens the agent or the project", async () => {
    const on = callbacks();
    const root = await show(
      ownerSnapshot({
        boxes: [
          box(),
          box({ ref: { kind: "project", id: "p1" }, name: "Alpha" }),
          box({ ref: { kind: "host", id: "h1" }, name: "Local", phase: null }),
        ],
      }),
      on,
    );
    await click(button(root, "Atlas"));
    await click(button(root, "Alpha"));
    await click(button(root, "Local"));
    expect(on.openAgent).toHaveBeenCalledWith("atlas-1a2b");
    expect(on.openProject).toHaveBeenCalledWith("p1");
    expect(on.openProject).toHaveBeenCalledWith("h1");
  });

  it("a starting card shows the launch step", async () => {
    useLaunchStore.getState().apply({
      kind: "snapshot",
      launches: [
        {
          id: "l1",
          box: { kind: "agent", id: "atlas-1a2b" },
          for: "start",
          startedAt: NOW,
          stoppable: true,
          steps: [
            {
              step: "image",
              state: "running",
              startedAt: NOW,
              endedAt: null,
              usualMs: null,
              deadlineAt: null,
              detail: null,
            },
          ],
        },
      ],
      helpers: { active: 0, max: 4, waiting: 0 },
    });
    const root = await show(ownerSnapshot({ boxes: [box({ state: "starting", phase: "starting" })] }));
    expect(root.querySelector("[data-launch-strip]")).not.toBeNull();
  });

  it("an agent box starting with no running step keeps the agent title", async () => {
    useLaunchStore.getState().apply({
      kind: "snapshot",
      launches: [
        {
          id: "l2",
          box: { kind: "agent", id: "atlas-1a2b" },
          for: "start",
          startedAt: NOW,
          stoppable: true,
          steps: [],
        },
      ],
      helpers: { active: 0, max: 4, waiting: 0 },
    });
    const root = await show(ownerSnapshot({ boxes: [box({ state: "starting", phase: "starting" })] }));
    expect(root.querySelector("[data-launch-strip]")?.textContent).toBe("Starting the agent");
  });

  it("the card slot shows what the route layer puts there", async () => {
    bed.handlers["overview.get"] = () => ownerSnapshot();
    const view = await mount(
      <OverviewPane {...callbacks()} actions={(b) => <span data-slot-probe="">{b.name}</span>} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector("[data-slot-probe]")?.textContent).toBe("Atlas");
  });
});

describe("OverviewPane: the stopped strip", () => {
  const sleeping = [
    box({ ref: { kind: "agent", id: "s-a" }, name: "Sleepy", state: "stopped", phase: "stopped" }),
    box({ ref: { kind: "project", id: "s-p" }, name: "Dozer", state: "stopped", phase: "stopped" }),
  ];

  it("is folded with its names while a box is active, and unfolds on EXPAND", async () => {
    const root = await show(ownerSnapshot({ boxes: [box(), ...sleeping] }));
    const strip = root.querySelector("[data-stopped-strip]") as HTMLElement;
    expect(text(strip)).toContain("2 stopped");
    expect(text(strip)).toContain("Sleepy");
    expect(text(strip)).toContain("Dozer");
    expect(strip.querySelectorAll("[data-stopped-row]")).toHaveLength(0);
    await click(button(strip, "Expand"));
    expect(strip.querySelectorAll("[data-stopped-row]")).toHaveLength(2);
    expect(cards(root)).toHaveLength(1);
  });

  it("starts expanded, with the E1 line, when no box is active", async () => {
    const root = await show(ownerSnapshot({ boxes: sleeping }));
    expect(root.querySelectorAll("[data-stopped-row]")).toHaveLength(2);
    expect(text(root)).toContain("Nothing is running. Start a box or open an agent to talk to it.");
  });

  it("is absent when nothing is stopped", async () => {
    const root = await show(ownerSnapshot());
    expect(root.querySelector("[data-stopped-strip]")).toBeNull();
  });
});

describe("OverviewPane: the empty states", () => {
  it("no boxes at all: E2, with New project as the only primary", async () => {
    const on = callbacks();
    const root = await show(ownerSnapshot({ boxes: [] }), on);
    expect(text(root)).toContain(
      "Here you will see every agent and every project: what runs, what waits for you, what it costs.",
    );
    const primaries = [...root.querySelectorAll("button")].filter((b) => b.className.includes("bg-you-fill"));
    expect(primaries.map((b) => b.textContent)).toEqual(["New project"]);
    await click(button(root, "New project"));
    await click(button(root, "New agent"));
    expect(on.newProject).toHaveBeenCalledOnce();
    expect(on.newAgent).toHaveBeenCalledOnce();
  });

  it("an unusable VM stack: E3 and CHECK AGAIN, which reads again", async () => {
    const root = await show(ownerSnapshot({ boxes: [], vmUsable: false }));
    expect(text(root)).toContain("Agents are unavailable");
    expect(text(root)).toContain("sudo pap vm setup");
    expect(root.textContent).not.toContain("Here you will see");
    const before = bed.called("overview.get").length;
    await click(button(root, "Check again"));
    expect(bed.called("overview.get").length).toBe(before + 1);
  });

  it("an unusable stack still lists host projects", async () => {
    const root = await show(
      ownerSnapshot({
        boxes: [box({ ref: { kind: "host", id: "h1" }, name: "Local", phase: null })],
        vmUsable: false,
      }),
    );
    expect(cards(root)).toHaveLength(1);
    expect(hasButton(root, "Check again")).toBe(true);
  });
});
