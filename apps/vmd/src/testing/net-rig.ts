import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNet } from "../net.ts";
import type { ExecResult, NetPort } from "../ops.ts";
import { createState } from "../state.ts";
import { createFakeClock, type FakeClock } from "./fake-clock.ts";
import { createFakeExec, type ExecHandler, type FakeExec } from "./fake-exec.ts";

export const BRIDGE_LIST = ["/usr/sbin/ip", "-j", "link", "show", "master", "pap0"];
export const PS = "/opt/pap-vm/bin/nerdctl";
export const MISSING_RESULT: Partial<ExecResult> = { code: 1, stderr: "Error: No such file or directory" };
export const mac = (last: number): string => `02:70:61:00:00:${last.toString(16).padStart(2, "0")}`;

export interface Rig {
  root: string;
  clock: FakeClock;
  logs: string[];
  fx: FakeExec;
  /** The ports `ip -j link show master pap0` reports (mutable); each name keeps one interface index, see `ifindex`. */
  ports: string[];
  ifindex: Map<string, number>;
  /** The `nerdctl ps` text. */
  ps: string;
  overrides: ExecHandler[];
  make(): NetPort;
  /** A whole start: allocate, snapshot, the VM's ports appear, attach. */
  launch(net: NetPort, name: string, ports: string[]): Promise<{ ip: string; mac: string }>;
}

const roots: string[] = [];

export function cleanupRigs(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function createRig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), "net-"));
  roots.push(root);
  const clock = createFakeClock();
  const logs: string[] = [];
  const log = {
    info: (event: string, fields: Record<string, unknown>) => logs.push(`${event} ${JSON.stringify(fields)}`),
  };
  const state = createState({ root, clock, log });
  state.ensure();
  let next = 10;
  const self: Rig = {
    root,
    clock,
    logs,
    ports: [],
    ifindex: new Map(),
    ps: "",
    overrides: [],
    fx: createFakeExec(async (argv) => {
      for (const override of self.overrides) {
        const answer = await override(argv);
        if (answer !== undefined) return answer;
      }
      if (argv.join(" ") === BRIDGE_LIST.join(" ")) {
        const links = self.ports.map((name) => {
          if (!self.ifindex.has(name)) self.ifindex.set(name, next++);
          return { ifindex: self.ifindex.get(name), ifname: name, master: "pap0" };
        });
        return { stdout: JSON.stringify(links) };
      }
      if (argv[0] === PS) return { stdout: self.ps };
      return undefined;
    }),
    make: () => createNet({ exec: self.fx.exec, state, clock, log }),
    async launch(net, name, ports) {
      const address = net.allocate(name);
      await net.prepare(name);
      self.ports = ports;
      await net.attach(name, address);
      return address;
    },
  };
  return self;
}

export const nonList = (calls: string[][]): string[][] =>
  calls.filter((call) => call.join(" ") !== BRIDGE_LIST.join(" "));
