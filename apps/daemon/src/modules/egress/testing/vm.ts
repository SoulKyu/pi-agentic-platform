import type { Socket } from "node:net";
import { loopbackBed } from "./loopback.ts";

/**
 * TEST ONLY: the seams of `createVmEgress` over local origins. Names resolve to `127.7.0.n` and connect to 127.0.0.1 through
 * `loopbackBed`; the address policy accepts everything (the real policy refuses loopback, which is all a test can reach), and
 * the host owns no address. `calls` records the resolver and the connector: what a test asserts DNS pinning on.
 * Only `*.test.ts` files import this folder; `egress.guard.test.ts` pins that.
 */
export function loopbackVmSeams(names: Readonly<Record<string, Readonly<Record<number, number>>>>) {
  const bed = loopbackBed(names);
  const calls = { resolve: [] as string[], connect: [] as Array<{ ip: string; port: number }> };
  return {
    calls,
    resolve: (host: string): Promise<readonly string[]> => (calls.resolve.push(host), bed.resolve(host)),
    connect: (ip: string, port: number): Socket => (calls.connect.push({ ip, port }), bed.connect(ip, port)),
    addressRefused: (): null => null,
    hostAddresses: (): readonly string[] => [],
  };
}
