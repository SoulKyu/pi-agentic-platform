import { afterEach, describe, expect, it } from "vitest";
import { VmdFailure } from "./errors.ts";
import type { ExecHandler } from "./testing/fake-exec.ts";
import { AGENT, createFixture, type Fixture } from "./testing/ops-fixture.ts";

let fx: Fixture;
const use = (handler?: ExecHandler): void => {
  if ((fx as Fixture | undefined) !== undefined) fx.cleanup();
  fx = createFixture(handler);
};
afterEach(() => fx.cleanup());

describe("dispatch", () => {
  it("answers the version", async () => {
    use();
    await expect(fx.ops.handle({ op: "version" })).resolves.toEqual({ version: "1.2.3" });
  });

  it("vmd.health reports the ruleset, the bridge and the free MiB", async () => {
    use((argv) => {
      if (argv[0] === "/usr/sbin/nft") return { stdout: "table bridge pap_agents {}\n" };
      if (argv.includes("link"))
        return { stdout: "7: pap0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n" };
      return undefined;
    });
    const health = await fx.ops.handle({ op: "vmd.health" });
    expect(health).toEqual({
      version: "1.2.3",
      ruleset: true,
      bridge: true,
      stateFreeMb: expect.any(Number),
    });
    expect(fx.exec.calls).toEqual([
      ["/usr/sbin/nft", "list", "table", "bridge", "pap_agents"],
      ["/usr/sbin/ip", "-o", "link", "show", "pap0"],
    ]);
  });

  it("vmd.health says false for a missing table and a bridge that is not up", async () => {
    use((argv) => {
      if (argv[0] === "/usr/sbin/nft") return { code: 1 };
      if (argv.includes("link"))
        return { stdout: "7: pap0: <NO-CARRIER,BROADCAST,MULTICAST> mtu 1500 state DOWN\n" };
      return undefined;
    });
    await expect(fx.ops.handle({ op: "vmd.health" })).resolves.toMatchObject({
      ruleset: false,
      bridge: false,
    });
  });

  it("a thrown VmdFailure keeps its code through the dispatch", async () => {
    use();
    await expect(fx.ops.handle({ op: "vm.stop", agentId: AGENT, taskKey: null })).resolves.toEqual({
      stopped: true,
    });
    fx.psCode = 1;
    await expect(fx.ops.handle({ op: "vm.list" })).rejects.toBeInstanceOf(VmdFailure);
  });
});
