import { describe, expect, it } from "vitest";
import { createRunView } from "./run-view.ts";
import { SNAPSHOT_ROWS } from "./snapshot.ts";

describe("run view", () => {
  it("has nothing to show outside a run", () => {
    const view = createRunView();
    expect(view.state()).toBeNull();
    view.push({ role: "user" });
    expect(view.state()).toBeNull();
  });

  it("holds the messages of the run on top of the file as it was when the run began", () => {
    const view = createRunView();
    view.begin(1234);
    view.push({ role: "user", content: "hi" });
    view.push({ role: "assistant" });
    expect(view.state()).toEqual({
      baselineBytes: 1234,
      messages: [{ role: "user", content: "hi" }, { role: "assistant" }],
    });
  });

  it("forgets everything when the run ends, and a new run starts from its own baseline", () => {
    const view = createRunView();
    view.begin(10);
    view.push({ role: "user" });
    view.end();
    expect(view.state()).toBeNull();
    view.begin(99);
    expect(view.state()).toEqual({ baselineBytes: 99, messages: [] });
  });

  it("keeps a run's baseline when the run is told to begin again", () => {
    const view = createRunView();
    view.begin(10);
    view.push({ role: "user" });
    view.begin(500);
    expect(view.state()).toEqual({ baselineBytes: 10, messages: [{ role: "user" }] });
  });

  it("keeps only as many messages as a snapshot can carry", () => {
    const view = createRunView();
    view.begin(0);
    for (let i = 0; i < SNAPSHOT_ROWS + 5; i++) view.push({ n: i });
    const messages = view.state()?.messages ?? [];
    expect(messages).toHaveLength(SNAPSHOT_ROWS);
    expect(messages.at(-1)).toEqual({ n: SNAPSHOT_ROWS + 4 });
    expect(messages[0]).toEqual({ n: 5 });
  });
});
