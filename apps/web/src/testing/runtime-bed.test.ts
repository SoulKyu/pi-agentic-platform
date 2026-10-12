import { describe, expect, it } from "vitest";
import { flush } from "../runtime/testing.ts";
import { fakeRuntime } from "./runtime-bed.ts";

describe("fakeRuntime", () => {
  it("emitTo reaches the shell listener when the shell subscribed first and a session second", async () => {
    const { runtime, emit, emitTo } = fakeRuntime();
    const shell: unknown[] = [];
    const session: unknown[] = [];
    runtime.subscriptions.subscribe("shell", "me", (event) => shell.push(event));
    runtime.subscriptions.subscribe("session", "k", (event) => session.push(event));
    await flush();
    emitTo("subscribe.shell", "to-shell");
    emitTo("subscribe.session", "to-session");
    emit("via-emit");
    expect(shell).toEqual(["to-shell"]);
    expect(session).toEqual(["to-session", "via-emit"]);
  });
});
