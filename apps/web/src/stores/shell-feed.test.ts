import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { shellSession, shellSnapshot } from "../testing/shell-snapshot.ts";
import { feedShell } from "./shell-feed.ts";
import { useShellStore } from "./shell-store.ts";

beforeEach(() => useShellStore.getState().reset());

describe("shell store", () => {
  it("fail(code) sets view.failed and a snapshot clears it", () => {
    useShellStore.getState().fail("capacity");
    expect(useShellStore.getState().view.failed).toBe("capacity");
    useShellStore.getState().apply(shellSnapshot([]));
    expect(useShellStore.getState().view).toMatchObject({ failed: null, loaded: true });
  });

  it("optimistic, confirm and rollback go through the reducer; reset empties it", () => {
    const { apply, optimistic, rollback, reset } = useShellStore.getState();
    apply(shellSnapshot([shellSession({ id: "a" })]));
    optimistic("c1", { sessions: [shellSession({ id: "a", archivedAt: 3 })] });
    expect(useShellStore.getState().view.sessions.get("a")?.archivedAt).toBe(3);
    rollback("c1");
    expect(useShellStore.getState().view.sessions.get("a")?.archivedAt).toBeNull();
    reset();
    expect(useShellStore.getState().view.loaded).toBe(false);
  });
});

describe("feedShell", () => {
  it("applies the events of the shell stream", async () => {
    const bed = fakeRuntime();
    feedShell(bed.runtime.subscriptions);
    await flush();
    bed.emitTo("subscribe.shell", shellSnapshot([shellSession({ id: "a" })]));
    expect([...useShellStore.getState().view.sessions.keys()]).toEqual(["a"]);
  });

  it("a refused subscription sets view.failed and calls onError once", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.shell"] = () => {
      throw new RpcError("capacity");
    };
    const onError = vi.fn();
    feedShell(bed.runtime.subscriptions, onError);
    await flush();
    expect(useShellStore.getState().view.failed).toBe("capacity");
    expect(onError).toHaveBeenCalledExactlyOnceWith("capacity");
  });
});
