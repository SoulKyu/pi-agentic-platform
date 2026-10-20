import type { Exec } from "./ops.ts";

/** What `vmd.health` reports and `vm.start` requires (AVM-E49): pap's nftables table is loaded and the pap0 bridge is up. */
export async function readNetFacts(exec: Exec): Promise<{ ruleset: boolean; bridge: boolean }> {
  const ruleset = (await exec(["/usr/sbin/nft", "list", "table", "bridge", "pap_agents"])).code === 0;
  const link = await exec(["/usr/sbin/ip", "-o", "link", "show", "pap0"]);
  const flags = /<([^>]*)>/.exec(link.stdout)?.[1]?.split(",") ?? [];
  return { ruleset, bridge: link.code === 0 && flags.includes("UP") };
}
