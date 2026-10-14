import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { skillsRpc } from "./rpc.ts";
import type { SkillsService } from "./service.ts";

const ctx = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s",
  closeSubscription: () => {},
};

describe("skillsRpc", () => {
  it("hands each method to one service call with the caller and the decoded params", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const record =
      (name: string, result: unknown) =>
      async (...args: unknown[]) => (calls.push([name, args]), result);
    const service = {
      list: record("list", {}),
      setInvocation: record("setInvocation", {}),
      search: record("search", {}),
      install: record("install", { ok: true }),
      listPlugins: record("listPlugins", {}),
      installPlugin: record("installPlugin", { ok: true }),
      removePlugin: record("removePlugin", { ok: true }),
      updatePlugins: record("updatePlugins", {}),
      setPluginsEnabled: record("setPluginsEnabled", {}),
    } as unknown as SkillsService;
    const rpc = skillsRpc(service);
    await rpc["skills.list"]({ cwd: "/w" }, ctx);
    await rpc["skills.setInvocation"]({ items: [{ path: "/a", disabled: true }] }, ctx);
    await rpc["skills.search"]({ query: "q" }, ctx);
    await rpc["skills.install"]({ source: "o/r", scope: "global" }, ctx);
    const plugin = { source: "npm:x", scope: "user" as const };
    await rpc["plugins.list"]({ cwd: "/w" }, ctx);
    await rpc["plugins.install"](plugin, ctx);
    await rpc["plugins.remove"](plugin, ctx);
    await rpc["plugins.update"]({}, ctx);
    await rpc["plugins.setEnabled"]({ items: [plugin], enabled: true }, ctx);
    expect(calls.slice(4)).toEqual([
      ["listPlugins", [ctx.caller, "/w"]],
      ["installPlugin", [ctx.caller, plugin]],
      ["removePlugin", [ctx.caller, plugin]],
      ["updatePlugins", [ctx.caller, {}]],
      ["setPluginsEnabled", [ctx.caller, { items: [plugin], enabled: true }]],
    ]);
    expect(calls.slice(0, 4)).toEqual([
      ["list", [ctx.caller, "/w"]],
      ["setInvocation", [ctx.caller, { items: [{ path: "/a", disabled: true }] }]],
      ["search", [ctx.caller, "q"]],
      ["install", [ctx.caller, { source: "o/r", scope: "global" }]],
    ]);
    expect(Object.keys(rpc).sort()).toEqual([
      "plugins.install",
      "plugins.list",
      "plugins.remove",
      "plugins.setEnabled",
      "plugins.update",
      "skills.install",
      "skills.list",
      "skills.search",
      "skills.setInvocation",
    ]);
  });
});
