import { type Notice, type SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createKeyedThrottle } from "./keyed-throttle.ts";
import { createPanels } from "./panels.ts";

function setup() {
  const clock = createFakeClock();
  const out: SessionStreamEvent[] = [];
  const cancelled: string[] = [];
  const said: Notice[] = [];
  const publish = (event: SessionStreamEvent) => out.push(event);
  const throttle = createKeyedThrottle({ clock, publish });
  const onStale = vi.fn();
  const panels = createPanels({
    clock,
    publish,
    cancel: (id) => cancelled.push(id),
    say: (notice) => said.push(notice),
    throttle,
    stale: onStale,
  });
  return { clock, out, cancelled, said, panels, throttle, onStale };
}

describe("panels", () => {
  it("folds two renders within 50 ms into one panel event with the latest lines", async () => {
    const { clock, out, panels } = setup();
    panels.render("p1", ["a"]);
    panels.render("p1", ["b"]);
    panels.render("p1", ["c"]);
    expect(out).toEqual([{ kind: "panel", panel: { id: "p1", lines: ["a"] } }]);
    await clock.advance(50);
    expect(out).toEqual([
      { kind: "panel", panel: { id: "p1", lines: ["a"] } },
      { kind: "panel", panel: { id: "p1", lines: ["c"] } },
    ]);
    expect(panels.list()).toEqual([{ id: "p1", lines: ["c"] }]);
    expect(panels.has("p1")).toBe(true);
  });

  it("cancels a fifth open panel and says so once in 10 s", async () => {
    const { clock, cancelled, said, panels, out } = setup();
    for (const id of ["p1", "p2", "p3", "p4"]) panels.render(id, ["x"]);
    panels.render("p5", ["x"]);
    expect(cancelled).toEqual(["p5"]);
    expect(said).toEqual([
      { level: "warning", text: "An extension opened too many panels. The extra one was cancelled." },
    ]);
    panels.render("p6", ["x"]);
    expect(cancelled).toEqual(["p5", "p6"]);
    expect(said).toHaveLength(1);
    expect(panels.has("p5")).toBe(false);
    expect(panels.list().map((panel) => panel.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(out.filter((event) => event.kind === "panel")).toHaveLength(4);
    await clock.advance(10_000);
    panels.render("p7", ["x"]);
    expect(said).toHaveLength(2);
  });

  it("close publishes a pending render first, then panel_closed", () => {
    const { out, panels, clock } = setup();
    panels.render("p1", ["a"]);
    panels.render("p1", ["b"]);
    panels.close("p1");
    expect(out.slice(1)).toEqual([
      { kind: "panel", panel: { id: "p1", lines: ["b"] } },
      { kind: "panel_closed", id: "p1" },
    ]);
    expect(panels.has("p1")).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("ignores a close for an id it never saw, and frees the slot of a closed panel", () => {
    const { out, panels, cancelled, said } = setup();
    panels.close("ghost");
    expect(out).toEqual([]);
    for (const id of ["p1", "p2", "p3", "p4"]) panels.render(id, ["x"]);
    panels.close("p1");
    panels.render("p5", ["x"]);
    expect(cancelled).toEqual([]);
    expect(said).toEqual([]);
    expect(panels.has("p5")).toBe(true);
  });

  it("ignores a render for a closed id, and remembers only the last 64 closed ids", () => {
    const { out, panels, onStale } = setup();
    panels.render("p1", ["a"]);
    panels.close("p1");
    panels.render("p1", ["late"]);
    expect(panels.has("p1")).toBe(false);
    expect(out.filter((event) => event.kind === "panel")).toHaveLength(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    for (let i = 2; i <= 65; i++) {
      panels.render(`p${i}`, ["a"]);
      panels.close(`p${i}`);
    }
    panels.render("p2", ["again"]);
    expect(panels.has("p2")).toBe(false);
    panels.render("p1", ["forgotten"]);
    expect(panels.has("p1")).toBe(true);
  });

  it("cuts lines to the limits", () => {
    const { out, panels } = setup();
    const lines = Array.from({ length: UI_LIMITS.panelLines + 10 }, () =>
      "y".repeat(UI_LIMITS.panelLineChars + 9),
    );
    panels.render("p1", lines);
    const event = out[0];
    if (event?.kind !== "panel") throw new Error("expected a panel event");
    expect(event.panel.lines).toHaveLength(UI_LIMITS.panelLines);
    expect(event.panel.lines[0]).toBe("y".repeat(UI_LIMITS.panelLineChars));
  });

  it("clear() returns the open ids and leaves nothing pending", async () => {
    const { clock, out, panels } = setup();
    panels.render("p1", ["a"]);
    panels.render("p1", ["b"]);
    panels.render("p2", ["a"]);
    expect(clock.pending()).toBe(2);
    expect(panels.clear()).toEqual(["p1", "p2"]);
    expect(clock.pending()).toBe(0);
    expect(panels.list()).toEqual([]);
    await clock.advance(100);
    expect(out).toHaveLength(2);
  });
});
