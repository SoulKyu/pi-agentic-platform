import type { DeliveryRpc } from "./delivery/rpc.ts";
import type { TransportRpc } from "./transport/rpc.ts";

export type PushRpc = TransportRpc & DeliveryRpc;

/** The seven `push.*` methods: chain A's four and chain B's three; this file only merges them (Task 1). */
export function pushRpc(transport: TransportRpc, delivery: DeliveryRpc): PushRpc {
  return { ...transport, ...delivery };
}
