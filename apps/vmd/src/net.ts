import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { AGENT_NET, portElement, VM_IPV4 } from "@pap/contracts";
import type { Clock } from "./clock.ts";
import { VmdFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { Exec, NetPort } from "./ops.ts";
import { NET_CALL_TIMEOUT_MS } from "./net-facts.ts";
import { psArgv, vmName } from "./argv.ts";
import { parseVmList } from "./ops-vm.ts";
import type { VmdState } from "./state.ts";

const NFT = "/usr/sbin/nft";
const IP = "/usr/sbin/ip";
const TABLE = ["bridge", "pap_agents", "ports"] as const;
const SUBNET_PREFIX = "10.213.0.";
const FIRST_HOST = 2;
const LAST_HOST = 254;
/** The port appears after `nerdctl run` returns: poll for up to 5 s. */
const PORT_WAIT_MS = 5000;
const PORT_POLL_MS = 250;
const INTERRUPTED = /Dump was interrupted/i;
const MISSING = /No such file or directory|does not exist|No such process/i;
const MAC_PREFIX = "02:70:61:00:00:";

export interface NetDeps {
  readonly exec: Exec;
  readonly state: VmdState;
  readonly clock: Clock;
  readonly log: Logger;
}

/** One address of one VM: reserved by `allocate` (`port` and `ifindex` null), bound to its bridge port by `attach`. */
interface Lease {
  readonly ip: string;
  readonly mac: string;
  readonly name: string;
  readonly port: string | null;
  readonly ifindex: number | null;
}
type Bound = Lease & { readonly port: string; readonly ifindex: number };
const isBound = (lease: Lease): lease is Bound => lease.port !== null && lease.ifindex !== null;

/** A port name that may enter an argv: `portElement` accepts it (and so has no `@`). */
function portNameAllowed(name: string): boolean {
  try {
    portElement({ port: name, mac: macOf(FIRST_HOST), ip: `${SUBNET_PREFIX}${FIRST_HOST}` });
    return true;
  } catch {
    return false;
  }
}

const macOf = (last: number): string => `${MAC_PREFIX}${last.toString(16).padStart(2, "0")}`;
const lastOctet = (ip: string): number => Number(ip.slice(SUBNET_PREFIX.length));

const addElementArgv = (element: string): string[] => [NFT, "add", "element", ...TABLE, element];
const deleteElementArgv = (element: string): string[] => [NFT, "delete", "element", ...TABLE, element];
const neighAddArgv = (ip: string, mac: string): string[] => [
  IP,
  "neigh",
  "replace",
  ip,
  "lladdr",
  mac,
  "dev",
  AGENT_NET.bridge,
  "nud",
  "permanent",
];
const neighDeleteArgv = (ip: string): string[] => [IP, "neigh", "del", ip, "dev", AGENT_NET.bridge];
const bridgePortsArgv = (): string[] => [IP, "-j", "link", "show", "master", AGENT_NET.bridge];

function parseLeases(text: string): Lease[] {
  const data: unknown = JSON.parse(text);
  const list = typeof data === "object" && data !== null && "leases" in data ? data.leases : null;
  if (!Array.isArray(list)) throw new Error("net: addresses.json is not a lease list");
  return list.map((raw: unknown): Lease => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { ip, mac, name, port, ifindex } = item;
    if (typeof ip !== "string" || !VM_IPV4.test(ip) || mac !== macOf(lastOctet(ip))) {
      throw new Error("net: addresses.json holds a bad address");
    }
    const bound = port !== null || ifindex !== null;
    if (typeof name !== "string" || (bound && (typeof port !== "string" || !Number.isInteger(ifindex)))) {
      throw new Error("net: addresses.json holds a bad lease");
    }
    return { ip, mac, name, port: port as string | null, ifindex: ifindex as number | null };
  });
}

/**
 * T16a (R22, RT-04): per-VM anti-spoofing. `allocate` picks an address and persists it; `attach` finds the VM's bridge port,
 * adds the guard set element and a permanent neighbour entry (until then the bridge drops the VM's frames: fail closed);
 * `detach` removes both; `restore` re-adds them for every VM that is not stopped after the unit reloaded the ruleset.
 * Every program is run by absolute path through `exec` (no shell); every value in an argv is checked first.
 */
export function createNet(deps: NetDeps): NetPort {
  const { state, clock, log } = deps;
  /** M6: an `ip` or `nft` call that hangs must not hold the start lock for the 120 s exec default. */
  const exec: Exec = (argv, options) => deps.exec(argv, { timeoutMs: NET_CALL_TIMEOUT_MS, ...options });
  const file = path.join(state.root, "run", "addresses.json");
  let leases: Lease[] = load();
  /** The bridge ports seen by `prepare`, per VM name; memory only (a restart of pap-vmd fails a start in flight). */
  const snapshots = new Map<string, Set<string>>();

  function load(): Lease[] {
    let text: string;
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseLeases(text);
  }

  /** Atomic like the state's files: a fresh file with `O_EXCL | O_NOFOLLOW`, then a rename over the old one. */
  function save(): void {
    const temp = `${file}.tmp`;
    rmSync(temp, { force: true });
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, JSON.stringify({ leases }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  }

  const replace = (next: Lease[]): void => {
    leases = next;
    save();
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => clock.setTimeout(resolve, ms));

  /** A delete of something that is not there is fine; any other failure is an error. */
  async function quietDelete(argv: string[]): Promise<void> {
    const result = await exec(argv);
    if (result.code !== 0 && !MISSING.test(result.stderr)) throw new Error("net: delete failed");
  }

  async function release(lease: Lease): Promise<void> {
    // Nothing was added for a lease without a port (the bind is recorded before the first command).
    if (lease.port === null) return;
    let failed = false;
    try {
      await quietDelete(deleteElementArgv(portElement({ port: lease.port, mac: lease.mac, ip: lease.ip })));
    } catch {
      failed = true;
    }
    try {
      await quietDelete(neighDeleteArgv(lease.ip));
    } catch {
      failed = true;
    }
    if (failed) throw new Error("net: release failed");
  }

  async function guard(lease: Bound): Promise<void> {
    // portElement throws for any port name, MAC or address outside its patterns: nothing unchecked reaches an argv.
    const element = portElement({ port: lease.port, mac: lease.mac, ip: lease.ip });
    if ((await exec(addElementArgv(element))).code !== 0) throw new Error("net: guard element refused");
    if ((await exec(neighAddArgv(lease.ip, lease.mac))).code !== 0)
      throw new Error("net: neighbour entry refused");
  }

  /**
   * The ports of the bridge with their interface index; null when `ip` fails, says its dump was interrupted (the listing may
   * be incomplete) or answers something else. Only items whose `master` is the bridge count; a name with `@` or one that
   * `portElement` refuses is logged and left out, so it can never be chosen.
   */
  async function listPorts(): Promise<Map<string, number> | null> {
    const result = await exec(bridgePortsArgv());
    if (result.code !== 0 || INTERRUPTED.test(result.stderr)) return null;
    try {
      const data: unknown = result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
      if (!Array.isArray(data)) return null;
      const ports = new Map<string, number>();
      for (const item of data as Record<string, unknown>[]) {
        const { ifname, ifindex, master } = item;
        if (master !== AGENT_NET.bridge) continue;
        if (typeof ifname !== "string" || typeof ifindex !== "number") return null;
        if (!portNameAllowed(ifname)) {
          log.info("vmd_net_port_name_refused", { length: ifname.length });
          continue;
        }
        ports.set(ifname, ifindex);
      }
      return ports;
    } catch {
      return null;
    }
  }

  /**
   * AVM-E37: the VM's port is the one port that is new since `prepare` and that no lease owns; an orphan of an earlier crash
   * is in the snapshot. A listing that failed is retried within the deadline; two new ports fail the start at once.
   */
  async function findPort(before: Set<string>): Promise<{ port: string; ifindex: number }> {
    const deadline = clock.now() + PORT_WAIT_MS;
    for (;;) {
      const ports = await listPorts();
      const owned = new Set(leases.flatMap((lease) => (lease.port === null ? [] : [lease.port])));
      const fresh = [...(ports ?? [])].filter(([port]) => !before.has(port) && !owned.has(port));
      const only = fresh.length === 1 ? fresh[0] : undefined;
      if (only !== undefined) return { port: only[0], ifindex: only[1] };
      if (fresh.length > 1) {
        log.info("vmd_net_port_not_found", { reason: `new_ports_${fresh.length}` });
        throw new VmdFailure("failed");
      }
      if (clock.now() >= deadline) {
        log.info("vmd_net_port_not_found", { reason: ports === null ? "ip_failed" : "no_new_port" });
        throw new VmdFailure("failed");
      }
      await sleep(PORT_POLL_MS);
    }
  }

  function allocate(name: string): { ip: string; mac: string } {
    const used = new Set(leases.map((lease) => lease.ip));
    for (let last = FIRST_HOST; last <= LAST_HOST; last += 1) {
      const ip = `${SUBNET_PREFIX}${last}`;
      if (used.has(ip)) continue;
      const mac = macOf(last);
      replace([...leases, { ip, mac, name, port: null, ifindex: null }]);
      return { ip, mac };
    }
    throw new VmdFailure("unavailable");
  }

  async function prepare(name: string): Promise<void> {
    const ports = await listPorts();
    if (ports === null) {
      log.info("vmd_net_prepare_failed", { reason: "ip_failed" });
      throw new VmdFailure("failed");
    }
    snapshots.set(name, new Set(ports.keys()));
  }

  async function attach(name: string, address: { ip: string; mac: string }): Promise<void> {
    const reserved = leases.find(
      (lease) =>
        lease.ip === address.ip && lease.mac === address.mac && lease.name === name && lease.port === null,
    );
    const before = snapshots.get(name);
    snapshots.delete(name);
    if (reserved === undefined || before === undefined) {
      log.info("vmd_net_attach_refused", {
        reason: reserved === undefined ? "not_allocated" : "not_prepared",
      });
      throw new VmdFailure("failed");
    }
    let found: { port: string; ifindex: number };
    try {
      // A leftover bound lease of this name (a start that was never detached) is released first.
      const old = leases.find((lease) => lease.name === name && lease !== reserved && lease.port !== null);
      if (old !== undefined) {
        replace(leases.filter((lease) => lease !== old));
        await release(old).catch(() => log.info("vmd_net_stale_release_failed", { ip: old.ip }));
      }
      found = await findPort(before);
      portElement({ port: found.port, mac: reserved.mac, ip: reserved.ip });
    } catch (error) {
      // The reservation stays: the start's cleanup calls `detach(name)`, which frees it.
      throw error instanceof VmdFailure ? error : new VmdFailure("failed");
    }
    // Recorded before the first command: a half-done attach is undone by `detach`.
    const bound: Bound = { ...reserved, port: found.port, ifindex: found.ifindex };
    replace(leases.map((lease) => (lease === reserved ? bound : lease)));
    try {
      await guard(bound);
    } catch (error) {
      log.info("vmd_net_attach_failed", { error: error instanceof Error ? error.message : "unknown" });
      throw new VmdFailure("failed");
    }
  }

  async function detach(name: string): Promise<void> {
    snapshots.delete(name);
    let failed = false;
    for (const lease of leases.filter((entry) => entry.name === name)) {
      // The address is only reusable once its guard is gone: a failed release keeps the lease and throws below.
      try {
        await release(lease);
        replace(leases.filter((entry) => entry !== lease));
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("net: detach failed");
  }

  async function restore(): Promise<readonly string[]> {
    const listed = await deps.exec(psArgv());
    if (listed.code !== 0) throw new Error("net: restore cannot list the VMs");
    // Same rule as vm.list: only an explicit stop counts as stopped, so an unknown status keeps its guard.
    const running = new Set(
      parseVmList(listed.stdout)
        .filter((entry) => entry.state !== "stopped")
        .map((entry) => vmName(entry.agentId, entry.taskKey)),
    );
    const ports = await listPorts();
    if (ports === null) throw new Error("net: restore cannot list the bridge ports");
    // AVM-E37 / T13b's rule: a lease is dropped only when its VM is explicitly stopped or absent.
    const keep: Lease[] = [];
    for (const lease of leases) {
      if (running.has(lease.name)) keep.push(lease);
      else await release(lease).catch(() => log.info("vmd_net_stale_release_failed", { ip: lease.ip }));
    }
    replace(keep);
    for (const lease of keep) {
      if (!isBound(lease)) {
        log.info("vmd_net_unbound_vm", { ip: lease.ip });
        continue;
      }
      // The saved port counts only if a port of that name still exists with the same interface index.
      if (ports.get(lease.port) !== lease.ifindex) {
        log.info("vmd_net_port_missing", { ip: lease.ip });
        continue;
      }
      await guard(lease);
    }
    const known = new Set(keep.map((lease) => lease.name));
    const unleased = [...running].filter((name) => !known.has(name));
    for (const name of unleased) log.info("vmd_net_unknown_vm", { vm: name });
    log.info("vmd_net_restored", { vms: keep.length });
    return unleased;
  }

  return { allocate, prepare, attach, detach, restore };
}

/** pap-vmd's start: the net with its guards back in place. It rejects when they cannot be restored, so nothing is served. */
export async function createRestoredNet(
  deps: NetDeps,
): Promise<{ net: NetPort; unleased: readonly string[] }> {
  const net = createNet(deps);
  return { net, unleased: await net.restore() };
}
