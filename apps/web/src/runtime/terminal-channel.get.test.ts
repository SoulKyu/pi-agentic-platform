// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { TERMINAL_ID } from "../testing/terminal-bed.ts";
import { getTerminalChannel } from "./terminal-channel.ts";
import { flush } from "./testing.ts";

const current = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock("./index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index.ts")>()),
  getRuntime: () => current.runtime,
}));

describe("getTerminalChannel", () => {
  it("is built once per runtime and drives that runtime's rpc; a new runtime gets a new channel", async () => {
    const first = fakeRuntime();
    current.runtime = first.runtime;
    const channel = getTerminalChannel();
    expect(getTerminalChannel()).toBe(channel);
    channel.open(TERMINAL_ID, {
      attached: () => {},
      reset: () => {},
      output: () => Promise.resolve(),
      exit: () => {},
      state: () => {},
    });
    await flush();
    expect(first.called("terminal.attach")).toHaveLength(1);

    current.runtime = fakeRuntime().runtime;
    expect(getTerminalChannel()).not.toBe(channel);
  });
});
