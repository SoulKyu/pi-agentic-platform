import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { flush } from "../testing/dom.ts";
import { feedSession } from "./session-feed.ts";
import { useSessionStore } from "./session-store.ts";

beforeEach(() => {
  useSessionStore.setState({ views: {} });
});

describe("feedSession", () => {
  it("applies the events of the session's stream to that session's view only", async () => {
    const bed = fakeRuntime();
    feedSession(bed.runtime.subscriptions, "a");
    await flush();
    bed.emit({
      kind: "snapshot",
      status: "running",
      rows: [],
      dialogs: [],
      partial: null,
      queue: { steering: [], followUp: [], count: 0, bytes: 0 },
      statuses: [],
      widgets: [],
      title: null,
      panels: [],
      notices: [],
      decorationsTruncated: false,
      history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
      activity: { compacting: false, retry: null },
      leafId: null,
      name: null,
    });
    const { views } = useSessionStore.getState();
    expect(views["a"]).toMatchObject({ status: "running", loaded: true });
    expect(views["b"]).toBeUndefined();
  });

  it("stops applying events once the feed is ended", async () => {
    const bed = fakeRuntime();
    const end = feedSession(bed.runtime.subscriptions, "a");
    await flush();
    end();
    bed.emit({ kind: "status", status: "idle" });
    expect(useSessionStore.getState().views["a"]).toBeUndefined();
  });

  it("reports a refusal to the caller and never subscribes a second time", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.session"] = () => {
      throw new RpcError("capacity");
    };
    const onError = vi.fn();
    feedSession(bed.runtime.subscriptions, "a", onError);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith("capacity");
    expect(bed.called("subscribe.session")).toHaveLength(1);
  });
});
