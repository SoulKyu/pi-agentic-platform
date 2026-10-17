// @vitest-environment happy-dom
import type { AgentEventView } from "@pap/contracts";
import { PAP_TEXT } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, hasButton, mount, text } from "../../testing/dom.ts";
import { EventCard } from "./EventCard.tsx";

const base = { id: 1, at: Date.UTC(2026, 9, 15, 8, 0), taskId: null } as const;
const run = (kind: "schedule" | "task", patch: Record<string, unknown> = {}): AgentEventView => ({
  ...base,
  kind,
  data: { title: "Nightly checks", state: "done", durationMs: 220_000, costUsd: 0.42, ...patch },
});
const notify: AgentEventView = {
  ...base,
  kind: "notify",
  data: { text: "Build <b>done</b>", itemId: "item-1" },
};
const reminder: AgentEventView = {
  ...base,
  kind: "reminder",
  data: { note: "Call the bank", setAt: base.at - 60_000 },
};
const isolated = (summary: string): AgentEventView => ({
  ...base,
  kind: "isolated",
  data: {
    title: "Feed digest",
    state: "done",
    source: "webhook",
    tainted: true,
    scratch: "/home/pap/agents/.runs/atlas/t1",
    summary,
    durationMs: 12_000,
    costUsd: 0.05,
  },
});
const delegation = (summary: string, isolatedRun: boolean): AgentEventView => ({
  ...base,
  kind: "delegation",
  data: {
    fromAgentId: "scout-1a2b",
    fromName: "Scout",
    state: "done",
    summary,
    clipped: false,
    tainted: false,
    isolated: isolatedRun,
  },
});
const show = (event: AgentEventView, extra: { folded?: string | null; mode?: "cards" | "compact" } = {}) => {
  const onInject = vi.fn();
  return mount(
    <EventCard
      event={event}
      folded={extra.folded ?? null}
      mode={extra.mode ?? "cards"}
      onInject={onInject}
    />,
  ).then((page) => ({ page, onInject }));
};
const frame = (container: HTMLElement) =>
  container.querySelector("[data-event-card]")?.getAttribute("data-frame");

describe("EventCard frames (DESIGN §2, M11R119)", () => {
  it.each([
    ["schedule", run("schedule")],
    ["task", run("task")],
    ["reminder", reminder],
    ["notify", notify],
  ])("draws a %s card in a solid frame", async (_name, event) => {
    const { page } = await show(event);
    expect(frame(page.container)).toBe("solid");
  });

  it.each([
    ["isolated", isolated("fine")],
    ["delegation", delegation("fine", false)],
  ])("draws a %s card in a dashed attention frame", async (_name, event) => {
    const { page } = await show(event);
    expect(frame(page.container)).toBe("dashed");
  });

  it("shows a run card's title, state, duration and cost, a subscription's cost as API-equivalent", async () => {
    const { page } = await show(run("task", { billing: "subscription" }));
    const words = text(page.container);
    expect(words).toContain("Nightly checks");
    expect(words).toContain("done");
    expect(words).toContain("3m40");
    expect(words).toContain("$0.42 API-equivalent");
  });

  it("shows a metered cost plainly", async () => {
    const { page } = await show(run("task", { billing: "api" }));
    expect(text(page.container)).toContain("$0.42");
    expect(text(page.container)).not.toContain("API-equivalent");
  });

  it("says Notification and shows the agent's words as text, never as markup", async () => {
    const { page } = await show(notify);
    expect(text(page.container)).toContain("Notification");
    expect(text(page.container)).toContain("Build <b>done</b>");
    expect(page.container.querySelector("b")).toBeNull();
  });
});

describe("EventCard untrusted text (RT-18)", () => {
  it("labels an isolated run's summary UNTRUSTED with its source and strips hidden characters", async () => {
    const { page } = await show(isolated("safe\u202etxet\u200b text"));
    const words = text(page.container);
    expect(words).toContain("UNTRUSTED · webhook");
    expect(words).toContain("safetxet text");
    expect(words).not.toMatch(/[\u202e\u200b]/);
  });

  it("names the scratch folder in pap's own words, outside the untrusted text", async () => {
    const { page } = await show(isolated("fine"));
    const line = page.container.querySelector("[data-scratch]");
    expect(line?.textContent).toContain("files in /home/pap/agents/.runs/atlas/t1");
    expect(line?.closest("[data-untrusted]")).toBeNull();
  });

  it("says a delegation ran as an isolated task only when it did", async () => {
    const yes = await show(delegation("done", true));
    expect(text(yes.page.container)).toContain("ran as an isolated task");
    const no = await show(delegation("done", false));
    expect(text(no.page.container)).not.toContain("ran as an isolated task");
  });

  it("folds a long summary past 16 lines and opens it on request", async () => {
    const lines = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`).join("\n");
    const { page } = await show(isolated(lines));
    expect(text(page.container)).toContain("line 16");
    expect(text(page.container)).not.toContain("line 17");
    await click(button(page.container, "Show all 20 lines"));
    expect(text(page.container)).toContain("line 20");
  });

  it("shows the tainted chip of an isolated run that read external content", async () => {
    const { page } = await show(isolated("fine"));
    expect(text(page.container)).toContain("external content");
  });
});

describe("EventCard Inject (M11R119)", () => {
  it("hands the fenced, stripped summary to the composer prefill and sends nothing", async () => {
    const { page, onInject } = await show(delegation("Report\u202e ready", false));
    await click(button(page.container, "Inject"));
    expect(onInject).toHaveBeenCalledTimes(1);
    const injected = String(onInject.mock.calls[0]?.[0]);
    expect(injected).toMatch(
      /<untrusted source="[A-Za-z0-9_.-]+" id="[0-9a-f]{12}">\nReport ready\n<\/untrusted id="[0-9a-f]{12}">/,
    );
    expect(injected).toContain("Scout");
    expect(injected).not.toContain("\u202e");
  });

  it("offers Inject on a delegation card only", async () => {
    const { page } = await show(isolated("fine"));
    expect(hasButton(page.container, "Inject")).toBe(false);
  });
});

describe("EventCard folded prompt", () => {
  it("carries the prompt pap sent under the card, as text", async () => {
    const { page } = await show(run("task"), {
      folded: "[pap task · Nightly checks] Sent by pap.\n<i>x</i>",
    });
    const details = page.container.querySelector("details");
    expect(details?.textContent).toContain("[pap task · Nightly checks] Sent by pap.");
    expect(details?.querySelector("i")).toBeNull();
  });
});

describe("EventCard compact mode (Task 16)", () => {
  it("is one line until clicked, then shows the card", async () => {
    const { page } = await show(run("task"), { mode: "compact" });
    const line = page.container.querySelector("[data-event-line]");
    expect(line?.textContent).toContain("Nightly checks");
    expect(page.container.querySelector("[data-event-card]")).toBeNull();
    await click(line?.querySelector("button") as HTMLElement);
    expect(frame(page.container)).toBe("solid");
  });

  it("keeps the dashed frame once an untrusted card is opened", async () => {
    const { page } = await show(isolated("fine"), { mode: "compact" });
    expect(page.container.querySelector("[data-event-card]")).toBeNull();
    await click(page.container.querySelector("[data-event-line] button") as HTMLElement);
    expect(frame(page.container)).toBe("dashed");
  });
});

describe("clipped text of a run", () => {
  it("clips the source of an isolated run to 500 units", async () => {
    const event = isolated("fine");
    const long = { ...event, data: { ...event.data, source: "s".repeat(600) } } as AgentEventView;
    const { page } = await show(long);
    const label = page.container.querySelector("figcaption")?.textContent ?? "";
    expect(label).toBe(`UNTRUSTED \u00b7 ${"s".repeat(499)}\u2026`);
  });
});

describe("EventCard text pap wrote itself (T12)", () => {
  afterEach(() => setLocale("en"));

  it("shows the undelivered-reminder card in the viewer's language, and any other title as it is", async () => {
    const note = run("task", { title: PAP_TEXT.reminderNotDelivered, state: "failed" });
    expect(text((await show(note)).page.container)).toContain("Reminder not delivered");
    setLocale("fr");
    const french = text((await show(note)).page.container);
    expect(french).toContain("Rappel non remis");
    expect(french).not.toContain("Reminder not delivered");
    expect(text((await show(run("task", { title: "Nightly checks" }))).page.container)).toContain(
      "Nightly checks",
    );
  });
});
