import type { Exec } from "./ops.ts";

/** An `ip` or `nft` call that takes longer than this is a failed call (M6). */
export const NET_CALL_TIMEOUT_MS = 5000;
const OPTIONS = { timeoutMs: NET_CALL_TIMEOUT_MS };

/** What `vmd.health` reports and `vm.start` requires (AVM-E49): pap's nftables table is loaded and the pap0 bridge is up. */
export async function readNetFacts(exec: Exec): Promise<{ ruleset: boolean; bridge: boolean }> {
  const ruleset =
    (await exec(["/usr/sbin/nft", "list", "table", "bridge", "pap_agents"], OPTIONS)).code === 0;
  const link = await exec(["/usr/sbin/ip", "-o", "link", "show", "pap0"], OPTIONS);
  const flags = /<([^>]*)>/.exec(link.stdout)?.[1]?.split(",") ?? [];
  return { ruleset, bridge: link.code === 0 && flags.includes("UP") };
}
