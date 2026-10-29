import { beforeEach, describe, expect, it } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { previewView } from "../testing/previews-fixtures.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedPreviews } from "./previews-feed.ts";
import { usePreviewsStore } from "./previews-store.ts";

beforeEach(() => usePreviewsStore.getState().reset());

describe("feedPreviews", () => {
  it("applies the events of the previews stream", async () => {
    const bed = fakeRuntime();
    feedPreviews(bed.runtime.subscriptions);
    await flush();
    bed.emitTo("subscribe.previews", { type: "snapshot", services: [previewView()] });
    expect(usePreviewsStore.getState().services.size).toBe(1);
    expect(usePreviewsStore.getState().ready).toBe(true);
  });

  it("the returned stop closes the subscription", async () => {
    const bed = fakeRuntime();
    const stop = feedPreviews(bed.runtime.subscriptions);
    await flush();
    stop();
    await flush();
    expect(bed.called("subscribe.previews")).toHaveLength(1);
    expect(bed.called("unsubscribe")).toHaveLength(1);
  });

  it("a refusal leaves the store empty and not ready", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.previews"] = () => {
      throw new RpcError("not_found");
    };
    feedPreviews(bed.runtime.subscriptions);
    await flush();
    expect(usePreviewsStore.getState().ready).toBe(false);
  });
});
