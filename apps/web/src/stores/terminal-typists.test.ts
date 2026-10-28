import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalTypists } from "./terminal-typists.ts";

const typist = (answer: "typed" | "multiline" | "not_ready" = "typed") => ({ handOff: () => answer });

beforeEach(() => useTerminalTypists.getState().reset());

describe("terminal typists", () => {
  it("register, newest wins, the remover removes only its own, reset", () => {
    const store = useTerminalTypists.getState();
    const first = typist();
    const second = typist("multiline");
    const removeFirst = store.register("t1", first);
    const removeSecond = useTerminalTypists.getState().register("t1", second);
    expect(useTerminalTypists.getState().typists["t1"]).toBe(second);
    removeFirst();
    expect(useTerminalTypists.getState().typists["t1"]).toBe(second);
    removeSecond();
    expect(useTerminalTypists.getState().typists).toEqual({});
    useTerminalTypists.getState().register("t2", first);
    useTerminalTypists.getState().reset();
    expect(useTerminalTypists.getState().typists).toEqual({});
  });
});
