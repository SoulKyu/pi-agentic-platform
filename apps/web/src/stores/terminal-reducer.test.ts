import { TERMINAL_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { terminalId, terminalView } from "../testing/m8-fixtures.ts";
import { EMPTY_TERMINALS, reduceTerminals } from "./terminal-reducer.ts";

const id = terminalId;

describe("terminal reducer", () => {
  it("a snapshot replaces the list and marks it loaded", () => {
    const first = reduceTerminals(EMPTY_TERMINALS, { kind: "snapshot", terminals: [terminalView(1)] });
    const second = reduceTerminals(first, {
      kind: "snapshot",
      terminals: [terminalView(2), terminalView(3)],
    });
    expect(second.loaded).toBe(true);
    expect(second.list.map((terminal) => terminal.id)).toEqual([id(2), id(3)]);
  });

  it("a terminal event adds or replaces, a closed event removes; the list stays oldest first", () => {
    let view = reduceTerminals(EMPTY_TERMINALS, { kind: "snapshot", terminals: [terminalView(2)] });
    view = reduceTerminals(view, { kind: "terminal", terminal: terminalView(1) });
    expect(view.list.map((terminal) => terminal.id)).toEqual([id(1), id(2)]);
    view = reduceTerminals(view, {
      kind: "terminal",
      terminal: terminalView(2, { status: "exited", exitCode: 0 }),
    });
    expect(view.list[1]).toMatchObject({ status: "exited", exitCode: 0 });
    view = reduceTerminals(view, { kind: "closed", id: id(1) });
    expect(view.list.map((terminal) => terminal.id)).toEqual([id(2)]);
  });

  it("an unknown kind or an invalid event leaves the state and is counted", () => {
    const base = reduceTerminals(EMPTY_TERMINALS, { kind: "snapshot", terminals: [terminalView(1)] });
    const unknown = reduceTerminals(base, { kind: "future" });
    expect(unknown.list).toBe(base.list);
    expect(unknown.skipped).toBe(1);
    expect(reduceTerminals(unknown, { kind: "terminal", terminal: { id: "x" } }).skipped).toBe(2);
  });

  it("holds at most TERMINAL_LIMITS.listed terminals, dropping the oldest exited ones first", () => {
    const all = Array.from({ length: TERMINAL_LIMITS.listed }, (_, n) =>
      terminalView(n + 10, n === 5 ? { status: "exited" } : {}),
    );
    let view = reduceTerminals(EMPTY_TERMINALS, { kind: "snapshot", terminals: all });
    view = reduceTerminals(view, { kind: "terminal", terminal: terminalView(1) });
    expect(view.list).toHaveLength(TERMINAL_LIMITS.listed);
    expect(view.list.some((terminal) => terminal.id === id(15))).toBe(false);
    expect(view.list.some((terminal) => terminal.id === id(1))).toBe(true);
  });
});
