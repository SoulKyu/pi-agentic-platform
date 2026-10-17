import type { AgentEventView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { dayKey, GROUP_GAP_MS, layoutThread, type Placed } from "./thread-items.vm.ts";
import type { InterleaveRow } from "../../stores/thread-interleave.ts";

const ZONE = "Europe/Paris";
const MIN = 60_000;
// 2026-10-15 10:00 in Paris (UTC+2).
const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

const row = (key: string, at: number | null, author: InterleaveRow["author"], text = key): InterleaveRow => ({
  key,
  at,
  author,
  text,
});
const task = (id: number, at: number, title = "Nightly"): AgentEventView => ({
  id,
  kind: "task",
  at,
  taskId: `t${id}`,
  data: { title, state: "done" },
});
const notify = (id: number, at: number): AgentEventView => ({
  id,
  kind: "notify",
  at,
  taskId: null,
  data: { text: "hello", itemId: "i1" },
});
const options = { zone: ZONE, hasOlder: false };
const kinds = (list: readonly Placed[] | undefined) => (list ?? []).map((one) => one.kind);

describe("layoutThread: cards between rows by time (M11R118)", () => {
  it("places a card before the first row that is not older than it, and a late card after the last row", () => {
    const rows = [row("a", T0, "you"), row("b", T0 + 10 * MIN, "agent"), row("c", T0 + 20 * MIN, "you")];
    const layout = layoutThread(rows, [task(1, T0 + 5 * MIN), notify(2, T0 + 30 * MIN)], options);
    expect(kinds(layout.before.get("a"))).toEqual([]);
    expect(layout.before.get("b")?.map((one) => one.key)).toEqual(["card:1"]);
    expect(layout.before.has("c")).toBe(false);
    expect(layout.after.map((one) => one.key)).toEqual(["card:2"]);
  });

  it("puts a card with the same time as a row before it (the card is written before the prompt)", () => {
    const layout = layoutThread([row("a", T0, "you")], [task(1, T0)], options);
    expect(layout.before.get("a")?.map((one) => one.key)).toEqual(["card:1"]);
  });

  it("orders cards by time then id, whatever order the page gave them (newest first)", () => {
    const layout = layoutThread([], [notify(3, T0 + 2 * MIN), task(1, T0), notify(2, T0 + 2 * MIN)], options);
    expect(layout.after.map((one) => one.key)).toEqual(["card:1", "card:2", "card:3"]);
  });

  it("keeps a card older than the loaded rows out until the older rows are loaded", () => {
    const rows = [row("a", T0 + 10 * MIN, "agent")];
    const older = [task(1, T0)];
    expect(layoutThread(rows, older, { ...options, hasOlder: true }).before.size).toBe(0);
    expect(layoutThread(rows, older, { ...options, hasOlder: true }).after).toEqual([]);
    expect(
      layoutThread(rows, older, options)
        .before.get("a")
        ?.map((one) => one.key),
    ).toEqual(["card:1"]);
  });

  it("gives a row without a time the time of the row before it", () => {
    const rows = [row("a", T0, "agent"), row("b", null, "agent"), row("c", T0 + 10 * MIN, "agent")];
    const layout = layoutThread(rows, [task(1, T0 + 5 * MIN)], options);
    expect(layout.before.get("c")?.map((one) => one.key)).toEqual(["card:1"]);
    expect(layout.breaks.has("b")).toBe(false);
  });
});

describe("layoutThread: day separators at local day changes", () => {
  it("separates rows on either side of local midnight, not of UTC midnight", () => {
    // 21:30 UTC on the 15th is 23:30 in Paris; 22:30 UTC is 00:30 on the 16th in Paris.
    const rows = [
      row("a", Date.UTC(2026, 9, 15, 21, 30), "you"),
      row("b", Date.UTC(2026, 9, 15, 22, 30), "agent"),
    ];
    const layout = layoutThread(rows, [], options);
    expect(kinds(layout.before.get("b"))).toEqual(["day"]);
    expect(layout.before.has("a")).toBe(false);
  });

  it("does not separate two rows of one local day that straddle UTC midnight in another zone", () => {
    const rows = [
      row("a", Date.UTC(2026, 9, 15, 21, 30), "you"),
      row("b", Date.UTC(2026, 9, 15, 21, 50), "agent"),
    ];
    expect(layoutThread(rows, [], options).before.size).toBe(0);
  });

  it("puts the separator before the card when the card opens the new day", () => {
    const rows = [
      row("a", Date.UTC(2026, 9, 15, 20, 0), "you"),
      row("b", Date.UTC(2026, 9, 16, 8, 0), "agent"),
    ];
    const layout = layoutThread(rows, [task(1, Date.UTC(2026, 9, 16, 7, 0))], options);
    expect(kinds(layout.before.get("b"))).toEqual(["day", "card"]);
  });

  it("names a day by its local date", () => {
    expect(dayKey(Date.UTC(2026, 9, 15, 22, 30), ZONE)).toBe("2026-10-16");
    expect(dayKey(Date.UTC(2026, 9, 15, 22, 30), "UTC")).toBe("2026-10-15");
  });
});

describe("layoutThread: the prompt a card sent is folded under it", () => {
  const prompt = "[pap task · Nightly] Sent by pap for the owner, not typed by them.\nRun the checks.";

  it("hides the [pap task] user message that follows the task card and hands its text to the card", () => {
    const rows = [row("a", T0, "agent"), row("p", T0 + MIN, "you", prompt), row("r", T0 + 2 * MIN, "agent")];
    const layout = layoutThread(rows, [task(1, T0 + MIN)], options);
    expect(layout.hidden.has("p")).toBe(true);
    const card = layout.before.get("r")?.[0];
    expect(card).toMatchObject({ kind: "card", key: "card:1", folded: prompt });
  });

  it("does not fold it under a card of another kind", () => {
    const rows = [row("p", T0 + MIN, "you", prompt)];
    const layout = layoutThread(rows, [notify(1, T0)], options);
    expect(layout.hidden.size).toBe(0);
    expect(layout.before.get("p")?.[0]).toMatchObject({ kind: "card", folded: null });
  });

  it("does not fold it when a row stands between the card and the message", () => {
    const rows = [row("x", T0 + MIN, "agent"), row("p", T0 + 2 * MIN, "you", prompt)];
    const layout = layoutThread(rows, [task(1, T0)], options);
    expect(layout.hidden.size).toBe(0);
  });

  it("folds it under the nearer of two cards only", () => {
    const rows = [row("p", T0 + 3 * MIN, "you", prompt)];
    const layout = layoutThread(rows, [task(1, T0), task(2, T0 + MIN)], options);
    expect(layout.hidden.has("p")).toBe(true);
    expect(layout.after).toMatchObject([
      { key: "card:1", folded: null },
      { key: "card:2", folded: prompt },
    ]);
  });

  it("leaves an ordinary message that merely quotes the marker later in the text", () => {
    const rows = [row("p", T0 + MIN, "you", `see ${prompt}`)];
    expect(layoutThread(rows, [task(1, T0)], options).hidden.size).toBe(0);
  });

  it("leaves a message of the agent that starts with the marker", () => {
    const rows = [row("p", T0 + MIN, "agent", prompt)];
    expect(layoutThread(rows, [task(1, T0)], options).hidden.size).toBe(0);
  });
});

describe("layoutThread: author groups", () => {
  it("breaks a group at 5 minutes and not before", () => {
    const rows = [
      row("a", T0, "agent"),
      row("b", T0 + GROUP_GAP_MS - 1, "agent"),
      row("c", T0 + 2 * GROUP_GAP_MS - 2, "agent"),
    ];
    const layout = layoutThread(rows, [], options);
    expect(layout.breaks.has("b")).toBe(false);
    expect(layout.breaks.has("c")).toBe(false);
    const gap = layoutThread([row("a", T0, "agent"), row("b", T0 + GROUP_GAP_MS, "agent")], [], options);
    expect(gap.breaks.has("b")).toBe(true);
  });

  it("breaks a group at a card", () => {
    const rows = [row("a", T0, "agent"), row("b", T0 + 2 * MIN, "agent")];
    const layout = layoutThread(rows, [notify(1, T0 + MIN)], options);
    expect(layout.breaks.has("b")).toBe(true);
  });
});
