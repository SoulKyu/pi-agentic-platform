import type { ExtensionProviders } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { forgetExtensions, readExtensions, refreshExtensions, useExtensionRead } from "./extension-read.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const answer = (name: string): ExtensionProviders => ({
  providers: [{ id: "x", name, models: [], modelsTruncated: false }],
  truncated: false,
  failed: false,
});
const nameNow = () => {
  const state = useExtensionRead.getState();
  return state.status === "ready" ? state.answer.providers[0]?.name : state.status;
};

let bed: ReturnType<typeof fakeRuntime>;
let answers: Array<(value: ExtensionProviders) => void>;
beforeEach(() => {
  bed = fakeRuntime();
  answers = [];
  bed.handlers["models.extensions"] = () =>
    new Promise<ExtensionProviders>((resolve) => void answers.push(resolve));
  current.runtime = bed.runtime;
});
afterEach(() => forgetExtensions());
const calls = () => bed.called("models.extensions").length;
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

describe("the tab's extension read", () => {
  it("refresh.unread: after a write, nothing read means nothing runs", () => {
    refreshExtensions();
    expect(calls()).toBe(0);
    expect(useExtensionRead.getState().status).toBe("idle");
  });

  it("refresh.keeps: a refresh keeps the answer on screen until the next one lands", async () => {
    readExtensions();
    answers[0]?.(answer("first"));
    await flush();
    expect(nameNow()).toBe("first");
    refreshExtensions();
    expect(calls()).toBe(2);
    expect(useExtensionRead.getState()).toMatchObject({ status: "ready", refreshing: true });
    expect(nameNow()).toBe("first");
    answers[1]?.(answer("second"));
    await flush();
    expect(useExtensionRead.getState()).toMatchObject({ status: "ready", refreshing: false });
    expect(nameNow()).toBe("second");
  });

  it("refresh.failure-keeps: a read again that fails keeps the last answer and says why (review M3)", async () => {
    let fail: (error: unknown) => void = () => {};
    readExtensions();
    answers[0]?.(answer("first"));
    await flush();
    bed.handlers["models.extensions"] = () => new Promise((_resolve, reject) => (fail = reject));
    refreshExtensions();
    fail(new RpcError("capacity"));
    await flush();
    await flush();
    expect(useExtensionRead.getState()).toMatchObject({
      status: "ready",
      refreshing: false,
      refreshFailed: "capacity",
    });
    expect(nameNow()).toBe("first");
  });

  it("refresh.trailing: a write during a read is followed by one more read, never two at once", async () => {
    readExtensions();
    refreshExtensions();
    refreshExtensions();
    expect(calls()).toBe(1);
    answers[0]?.(answer("before the write"));
    await flush();
    expect(calls()).toBe(2);
    answers[1]?.(answer("after the write"));
    await flush();
    expect(calls()).toBe(2);
    expect(nameNow()).toBe("after the write");
  });
});
