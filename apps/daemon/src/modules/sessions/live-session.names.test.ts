import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);

describe("the session's name", () => {
  it("hands a clipped name from ready to onName, once", () => {
    const { names, published, live } = setup({ sessionName: "n".repeat(300) });
    expect(names).toEqual(["n".repeat(256)]);
    expect(live.name()).toBe("n".repeat(256));
    expect(published.filter((event) => event.kind === "name")).toEqual([]);
  });

  it("says nothing for a session without a name", () => {
    const { names, live } = setup();
    expect(names).toEqual([]);
    expect(live.name()).toBeNull();
  });

  it("publishes session_info_changed as a name event, clipped, and never as a Pi event", async () => {
    const { worker, published, names, live, clock } = setup();
    worker.emit(piEvent({ type: "session_info_changed", name: `  ‮Fix   login ${"x".repeat(400)}` }));
    await clock.advance(0);
    const expected = `Fix login ${"x".repeat(400)}`.slice(0, 256);
    expect(published).toContainEqual({ kind: "name", name: expected });
    expect(published.some((event) => event.kind === "pi")).toBe(false);
    expect(names).toEqual([expected]);
    expect(live.name()).toBe(expected);
  });

  it("treats a cleared name, or one that is not text, as no name, and repeats nothing", async () => {
    const { worker, published, names, clock } = setup({ sessionName: "old" });
    worker.emit(piEvent({ type: "session_info_changed" }));
    worker.emit(piEvent({ type: "session_info_changed", name: 7 }));
    await clock.advance(0);
    // The second change leaves the name as it is: nothing is stored or published twice.
    expect(names).toEqual(["old", null]);
    expect(published.filter((event) => event.kind === "name")).toEqual([{ kind: "name", name: null }]);
  });
});
