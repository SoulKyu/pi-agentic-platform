import { methods, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { agentsPackagesRpc, createAgentPackages } from "./packages.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const plugin = (id: string, source: string, scope: "user" | "project" = "user") => ({
  id,
  source,
  scope,
  installedPath: null,
  enabled: true,
  filtered: false,
});
const make = (answer: unknown) => {
  const run = vi.fn(() => ({ done: Promise.resolve(answer) }));
  const warn = vi.fn();
  return { run, warn, packages: createAgentPackages({ helpers: { run } as never, logger: { warn } }) };
};

describe("agents.packages", () => {
  it("returns ids and masked sources to a member, from the helper's user scope only", async () => {
    const { run, packages } = make({
      plugins: [
        plugin(ID_A, "npm:left-pad"),
        plugin(ID_B, "git:***@host/x", "project"),
        plugin(ID_A, "npm:left-pad"),
      ],
      truncated: false,
    });
    const rpc = agentsPackagesRpc(packages);
    const ctx = { caller: testCaller({ userId: "member1" }) } as never;
    expect(await rpc["agents.packages"]({}, ctx)).toEqual({
      packages: [{ id: ID_A, source: "npm:left-pad" }],
    });
    // No folder: the helper reads the user's Pi folder only, never a project's.
    expect(run).toHaveBeenCalledWith("plugins.list", {}, { deadlineMs: 30_000 });
  });

  it("cuts a source the helper allows but the result schema does not, so one long source never breaks the answer", async () => {
    const { packages } = make({ plugins: [plugin(ID_A, `npm:${"x".repeat(2000)}`)], truncated: false });
    const rpc = agentsPackagesRpc(packages);
    const result = await rpc["agents.packages"]({}, { caller: testCaller() } as never);
    expect(result.packages[0]?.source).toHaveLength(1024);
    expect(methods["agents.packages"].result.safeParse(result).success).toBe(true);
  });

  it("fails closed with helper_failed on an answer that is not a package list", async () => {
    const { packages, warn } = make({ plugins: "no" });
    await expect(packages.list()).rejects.toEqual(new PapError("helper_failed"));
    expect(warn).toHaveBeenCalledWith("agent_packages_result_invalid", expect.anything());
  });
});
