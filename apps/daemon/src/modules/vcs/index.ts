import { type VcsDeps, createVcsService } from "./service.ts";
import { type VcsRpc, vcsRpc } from "./rpc.ts";

export type { VcsRpc };

export interface VcsModule {
  readonly rpc: VcsRpc;
  /** Stops the polls and drops the cached statuses. */
  shutdown(): void;
}

export function createVcsModule(deps: VcsDeps): VcsModule {
  const service = createVcsService(deps);
  return { rpc: vcsRpc(service), shutdown: () => service.shutdown() };
}
