import type { NetPort } from "../ops.ts";

export interface FakeNet extends NetPort {
  /** `allocate`, `attach <name>` and `detach <name>`, in order. */
  readonly events: string[];
  failAttach: boolean;
  /** When set, the next `attach` waits for it and then fails (a port that never shows up in time). */
  gate: Promise<void> | null;
}

/** `order`, when given, also receives `prepare <name>` and `attach <name>` so a test can interleave them with the exec calls. */
export function createFakeNet(order: string[] = []): FakeNet {
  const events: string[] = [];
  let next = 2;
  const net: FakeNet = {
    events,
    failAttach: false,
    gate: null,
    allocate() {
      const last = next++;
      events.push("allocate");
      return { ip: `10.213.0.${last}`, mac: `02:70:61:00:00:${last.toString(16).padStart(2, "0")}` };
    },
    prepare(name) {
      events.push(`prepare ${name}`);
      order.push(`prepare ${name}`);
      return Promise.resolve();
    },
    attach(name) {
      events.push(`attach ${name}`);
      order.push(`attach ${name}`);
      if (net.gate !== null) {
        const gate = net.gate;
        net.gate = null;
        return gate.then(() => Promise.reject(new Error("no bridge port")));
      }
      return net.failAttach ? Promise.reject(new Error("no bridge port")) : Promise.resolve();
    },
    detach(name) {
      events.push(`detach ${name}`);
      return Promise.resolve();
    },
    restore: () => Promise.resolve(),
  };
  return net;
}
