import { connect, type Socket } from "node:net";

/**
 * TEST ONLY (M11R244): a resolver, a deny list and a connector that map test names and ports to servers on 127.0.0.1.
 * Only `*.test.ts` files import this folder; `egress.guard.test.ts` pins that, and that `index.ts` never builds one.
 */
export interface LoopbackBed {
  resolve(host: string): Promise<readonly string[]>;
  denies(ip: string): boolean;
  connect(ip: string, port: number): Socket;
}

export function loopbackBed(names: Readonly<Record<string, Readonly<Record<number, number>>>>): LoopbackBed {
  const entries = Object.entries(names);
  const ipOf = (index: number): string => `127.7.0.${index + 1}`;
  return {
    resolve: async (host) => {
      const index = entries.findIndex(([name]) => name === host);
      if (index < 0) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return [ipOf(index)];
    },
    denies: () => false,
    connect: (ip, port) => {
      const target = entries.find((_, index) => ipOf(index) === ip)?.[1][port];
      if (target === undefined) throw new Error(`no loopback mapping for ${ip}:${port}`);
      return connect({ host: "127.0.0.1", port: target });
    },
  };
}
