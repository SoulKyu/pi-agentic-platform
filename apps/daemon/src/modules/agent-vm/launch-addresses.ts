import type { VmScope } from "../egress/index.ts";

export type LaunchScope = Omit<VmScope, "hosts">;

/**
 * Which running launch sits behind a VM's bridge address (spec §3): the egress proxy identifies an agent by its source
 * address alone. Added when a VM starts, removed where the relay's grant is revoked. A new launch on a reused address
 * replaces the old one, and the old one's late removal leaves the new one alone.
 */
export function createLaunchAddresses() {
  const byAddress = new Map<string, LaunchScope>();
  const byLaunch = new Map<string, string>();
  return {
    add(address: string, scope: LaunchScope): void {
      byAddress.set(address, scope);
      byLaunch.set(scope.launchId, address);
    },
    remove(launchId: string): void {
      const address = byLaunch.get(launchId);
      if (address === undefined) return;
      byLaunch.delete(launchId);
      if (byAddress.get(address)?.launchId === launchId) byAddress.delete(address);
    },
    scopeOf: (address: string): LaunchScope | null => byAddress.get(address) ?? null,
  };
}
