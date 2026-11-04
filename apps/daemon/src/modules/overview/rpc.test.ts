import type { HandlerContext, OverviewSnapshot } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { overviewRpc } from "./rpc.ts";

const ctxOf = (
  userId: string,
  openSubscription: (stream: string, key: string, after?: unknown) => string = () => "sub-1",
  permissions: string[] = [],
) =>
  ({ caller: { userId, permissions: new Set(permissions) }, openSubscription }) as unknown as HandlerContext;

describe("overview rpc", () => {
  it("reads the Overview of the caller the transport stamped", async () => {
    const get = vi.fn(async (id: string) => ({ id }) as unknown as OverviewSnapshot);
    const rpc = overviewRpc({ get, subscribe: () => "unused" });
    await expect(rpc["overview.get"]({}, ctxOf("u7"))).resolves.toEqual({ id: "u7" });
    expect(get).toHaveBeenCalledWith("u7", { members: false, failures: false });
  });

  it("derives the scope from the caller's permissions: users:read for members, pi:admin for failures", async () => {
    const get = vi.fn(async (id: string, scope: unknown) => ({ id, scope }) as unknown as OverviewSnapshot);
    const rpc = overviewRpc({ get, subscribe: () => "unused" });
    const noop = (): string => "s";
    await rpc["overview.get"]({}, ctxOf("u", noop, ["users:read"]));
    await rpc["overview.get"]({}, ctxOf("u", noop, ["pi:admin"]));
    await rpc["overview.get"]({}, ctxOf("u", noop, ["sessions:read", "users:read", "pi:admin"]));
    expect(get.mock.calls.map((call) => call[1])).toEqual([
      { members: true, failures: false },
      { members: false, failures: true },
      { members: true, failures: true },
    ]);
  });

  it("opens the stream on the caller's own key, after registering the viewer", async () => {
    const order: string[] = [];
    const open = vi.fn((_stream: string, key: string, after?: unknown) => {
      order.push(`open:${key}:${JSON.stringify(after)}`);
      return "sub-9";
    });
    const rpc = overviewRpc({
      get: async () => ({}) as OverviewSnapshot,
      subscribe(viewerId, openFor) {
        order.push(`register:${viewerId}`);
        return openFor(viewerId);
      },
    });
    const after = { epoch: "e", seq: 4 };
    await expect(rpc["subscribe.overview"]({ after }, ctxOf("u7", open))).resolves.toEqual({ sub: "sub-9" });
    expect(open).toHaveBeenCalledWith("overview", "u7", after);
    expect(order).toEqual(["register:u7", `open:u7:${JSON.stringify(after)}`]);
  });
});
