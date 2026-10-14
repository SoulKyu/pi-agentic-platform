import { beforeEach, describe, expect, it } from "vitest";
import { flush } from "../testing/dom.ts";
import { terminalView } from "../testing/m8-fixtures.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedTerminals } from "./terminal-feed.ts";
import { useTerminalStore } from "./terminal-store.ts";

beforeEach(() => useTerminalStore.getState().reset());

describe("feedTerminals", () => {
  it("applies the events of the terminal stream; reset empties the store", async () => {
    const bed = fakeRuntime();
    feedTerminals(bed.runtime.subscriptions);
    await flush();
    bed.emitTo("subscribe.terminal", { kind: "snapshot", terminals: [terminalView(1)] });
    expect(useTerminalStore.getState().view.list).toHaveLength(1);
    useTerminalStore.getState().reset();
    expect(useTerminalStore.getState().view.loaded).toBe(false);
  });

  it("two feeders share one subscription, which closes with the last one", async () => {
    const bed = fakeRuntime();
    const first = feedTerminals(bed.runtime.subscriptions);
    const second = feedTerminals(bed.runtime.subscriptions);
    await flush();
    expect(bed.called("subscribe.terminal")).toHaveLength(1);
    bed.emitTo("subscribe.terminal", { kind: "snapshot", terminals: [terminalView(1)] });
    expect(useTerminalStore.getState().view.list).toHaveLength(1);
    first();
    first();
    await flush();
    expect(bed.called("unsubscribe")).toHaveLength(0);
    second();
    await flush();
    expect(bed.called("unsubscribe")).toHaveLength(1);
  });
});
