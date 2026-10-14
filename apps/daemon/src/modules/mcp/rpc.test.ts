import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { mcpRpc } from "./rpc.ts";
import type { McpService } from "./service.ts";

const ctx = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s",
  closeSubscription: () => {},
};

describe("mcpRpc", () => {
  it("hands mcp.overview to one service call with the caller and the cwd", async () => {
    const seen: unknown[] = [];
    const rpc = mcpRpc({
      overview: async (caller: unknown, cwd: unknown) => (
        seen.push([(caller as { userId: string }).userId, cwd]),
        {}
      ),
    } as unknown as McpService);
    await rpc["mcp.overview"]({ cwd: "/w" }, ctx);
    await rpc["mcp.overview"]({}, ctx);
    expect(seen).toEqual([
      ["u1", "/w"],
      ["u1", undefined],
    ]);
  });

  it("hands every write to one service method with the caller and the decoded params, and nothing else", async () => {
    const calls: Array<[string, unknown]> = [];
    const service = Object.fromEntries(
      [
        "overview",
        "setEnabled",
        "setExposure",
        "setInProject",
        "remove",
        "undo",
        "add",
        "setCodemode",
        "test",
      ].map((name) => [
        name,
        async (_caller: unknown, params: unknown) => (calls.push([name, params]), { ok: true }),
      ]),
    ) as unknown as McpService;
    const rpc = mcpRpc(service);
    expect(Object.keys(rpc).sort()).toEqual(
      [
        "add",
        "overview",
        "remove",
        "setCodemode",
        "setEnabled",
        "setExposure",
        "setInProject",
        "test",
        "undo",
      ]
        .map((name) => `mcp.${name}`)
        .sort(),
    );
    const params = { token: "t" };
    await (rpc["mcp.undo"] as (p: unknown, c: unknown) => Promise<unknown>)(params, ctx);
    await (rpc["mcp.setCodemode"] as (p: unknown, c: unknown) => Promise<unknown>)({ mode: "only" }, ctx);
    await (rpc["mcp.test"] as (p: unknown, c: unknown) => Promise<unknown>)(
      { scope: "global", name: "a" },
      ctx,
    );
    expect(calls).toEqual([
      ["undo", params],
      ["setCodemode", { mode: "only" }],
      ["test", { scope: "global", name: "a" }],
    ]);
  });
});
