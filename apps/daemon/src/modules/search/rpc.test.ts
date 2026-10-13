import type { HandlerContext } from "@pap/contracts";
import { expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { searchRpc } from "./rpc.ts";
import type { SearchService } from "./service.ts";

it("search.query passes the transport's caller and the params to the service", async () => {
  const query = vi.fn(async () => ({ hits: [] }));
  const ctx: HandlerContext = {
    caller: testCaller({ userId: "u9" }),
    connectionId: "c1",
    openSubscription: vi.fn(),
    closeSubscription: vi.fn(),
  };
  const rpc = searchRpc({ query } as unknown as SearchService);
  await expect(rpc["search.query"]({ q: "kube", limit: 3 }, ctx)).resolves.toEqual({ hits: [] });
  expect(query).toHaveBeenCalledWith(ctx.caller, { q: "kube", limit: 3 });
});
