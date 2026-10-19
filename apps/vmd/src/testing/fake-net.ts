import type { NetPort } from "../ops.ts";

export interface FakeNet extends NetPort {
  /** `allocate`, `attach <name>` and `detach <name>`, in order. */
  readonly events: string[];
  failAttach: boolean;
}

export function createFakeNet(): FakeNet {
  const events: string[] = [];
  let next = 2;
  const net: FakeNet = {
    events,
    failAttach: false,
    allocate() {
      const last = next++;
      events.push("allocate");
      return { ip: `10.213.0.${last}`, mac: `02:70:61:00:00:${last.toString(16).padStart(2, "0")}` };
    },
    prepare(name) {
      events.push(`prepare ${name}`);
      return Promise.resolve();
    },
    attach(name) {
      events.push(`attach ${name}`);
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
