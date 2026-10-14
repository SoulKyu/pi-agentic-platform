import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { vcsStatus } from "../testing/m8-fixtures.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedVcs } from "./vcs-feed.ts";
import { useVcsStore } from "./vcs-store.ts";

beforeEach(() => useVcsStore.getState().reset());

describe("feedVcs", () => {
  it("subscribes with the root as the key and applies the events to that root", async () => {
    const bed = fakeRuntime();
    feedVcs(bed.runtime.subscriptions, "/w");
    await flush();
    expect(bed.called("subscribe.vcs")[0]?.params).toEqual({ root: "/w" });
    bed.emitTo("subscribe.vcs", { kind: "snapshot", status: vcsStatus("/w", { branch: "dev" }) });
    expect(useVcsStore.getState().view.statuses.get("/w")?.branch).toBe("dev");
  });

  it("a refused subscription reaches onError", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.vcs"] = () => {
      throw new RpcError("not_found");
    };
    const onError = vi.fn();
    feedVcs(bed.runtime.subscriptions, "/w", onError);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith("not_found");
  });
});
