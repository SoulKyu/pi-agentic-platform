import { closeSync, constants, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { AGENT_NET, portElement, VM_IPV4 } from "@pap/contracts";
import type { Clock } from "./clock.ts";
import { VmdFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { Exec, NetPort } from "./ops.ts";
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
/** An address handed out but never attached (the start failed in between) is free again after this long. */
const PENDING_TTL_MS = 15 * 60 * 1000;
const MISSING = /No such file or directory|does not exist|No such process/i;
const LINK_LINE = /^\d+:\s+([^\s:@]+)(?:@[^\s:]+)?:/;
const MAC_PREFIX = "02:70:61:00:00:";

export interface NetDeps {
  readonly exec: Exec;
  readonly state: VmdState;
  readonly clock: Clock;
  readonly log: Logger;
}

/** One address: reserved by `allocate` (`name` and `port` null), bound to a VM and its bridge port by `attach`. */
interface Lease {
  readonly ip: string;
  readonly mac: string;
  readonly name: string | null;
  readonly port: string | null;
  readonly at: number;
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
const bridgePortsArgv = (): string[] => [IP, "-o", "link", "show", "master", AGENT_NET.bridge];

function parseLeases(text: string): Lease[] {
  const data: unknown = JSON.parse(text);
  const list = typeof data === "object" && data !== null && "leases" in data ? data.leases : null;
  if (!Array.isArray(list)) throw new Error("net: addresses.json is not a lease list");
  return list.map((raw: unknown): Lease => {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { ip, mac, name, port, at } = item;
    if (typeof ip !== "string" || !VM_IPV4.test(ip) || mac !== macOf(lastOctet(ip))) {
      throw new Error("net: addresses.json holds a bad address");
    }
    if ((name !== null && typeof name !== "string") || (port !== null && typeof port !== "string")) {
      throw new Error("net: addresses.json holds a bad lease");
    }
    if (typeof at !== "number" || !Number.isFinite(at))
      throw new Error("net: addresses.json holds a bad time");
    return { ip, mac, name, port, at };
  });
}

/**
 * T16a (R22, RT-04): per-VM anti-spoofing. `allocate` picks an address and persists it; `attach` finds the VM's bridge port,
 * adds the guard set element and a permanent neighbour entry (until then the bridge drops the VM's frames: fail closed);
 * `detach` removes both; `restore` re-adds them for every VM that is not stopped after the unit reloaded the ruleset.
 * Every program is run by absolute path through `exec` (no shell); every value in an argv is checked first.
 */
export function createNet(deps: NetDeps): NetPort {
  const { exec, state, clock, log } = deps;
  const file = path.join(state.root, "run", "addresses.json");
  let leases: Lease[] = load();

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
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  }

  const expired = (lease: Lease): boolean => lease.name === null && clock.now() - lease.at > PENDING_TTL_MS;
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
    let failed = false;
    if (lease.port !== null) {
      try {
        await quietDelete(deleteElementArgv(portElement({ port: lease.port, mac: lease.mac, ip: lease.ip })));
      } catch {
        failed = true;
      }
    }
    try {
      await quietDelete(neighDeleteArgv(lease.ip));
    } catch {
      failed = true;
    }
    if (failed) throw new Error("net: release failed");
  }

  async function guard(lease: Lease & { readonly port: string }): Promise<void> {
    // portElement throws for any port name, MAC or address outside its patterns: nothing unchecked reaches an argv.
    const element = portElement({ port: lease.port, mac: lease.mac, ip: lease.ip });
    if ((await exec(addElementArgv(element))).code !== 0) throw new Error("net: guard element refused");
    if ((await exec(neighAddArgv(lease.ip, lease.mac))).code !== 0)
      throw new Error("net: neighbour entry refused");
  }

  async function listPorts(): Promise<string[] | null> {
    const result = await exec(bridgePortsArgv());
    if (result.code !== 0) return null;
    return result.stdout.split("\n").flatMap((line) => {
      const name = LINK_LINE.exec(line)?.[1];
      return name === undefined ? [] : [name];
    });
  }

  /** The new port of the bridge: the one no VM owns yet. Starts are serialised by the caller, so there is at most one. */
  async function findPort(): Promise<string> {
    const deadline = clock.now() + PORT_WAIT_MS;
    for (;;) {
      const ports = await listPorts();
      const bound = new Set(leases.flatMap((lease) => (lease.port === null ? [] : [lease.port])));
      const fresh = (ports ?? []).filter((port) => !bound.has(port));
      if (fresh.length === 1 && fresh[0] !== undefined) return fresh[0];
      if (clock.now() >= deadline) throw new VmdFailure("failed");
      await sleep(PORT_POLL_MS);
    }
  }

  function allocate(): { ip: string; mac: string } {
    const live = leases.filter((lease) => !expired(lease));
    const used = new Set(live.map((lease) => lease.ip));
    for (let last = FIRST_HOST; last <= LAST_HOST; last += 1) {
      const ip = `${SUBNET_PREFIX}${last}`;
      if (used.has(ip)) continue;
      const mac = macOf(last);
      replace([...live, { ip, mac, name: null, port: null, at: clock.now() }]);
      return { ip, mac };
    }
    throw new VmdFailure("unavailable");
  }

  async function attach(name: string, address: { ip: string; mac: string }): Promise<void> {
    const reserved = leases.find(
      (lease) => lease.ip === address.ip && lease.mac === address.mac && lease.name === null,
    );
    if (reserved === undefined) throw new VmdFailure("failed");
    const dropReservation = (): void => replace(leases.filter((lease) => lease !== reserved));
    let port: string;
    try {
      // A leftover lease of this name (a start that was never detached) is released first.
      const old = leases.find((lease) => lease.name === name);
      if (old !== undefined) {
        replace(leases.filter((lease) => lease !== old));
        await release(old).catch(() => log.info("vmd_net_stale_release_failed", { ip: old.ip }));
      }
      port = await findPort();
      portElement({ port, mac: reserved.mac, ip: reserved.ip });
    } catch (error) {
      dropReservation();
      throw error instanceof VmdFailure ? error : new VmdFailure("failed");
    }
    // Recorded before the first command: a half-done attach is undone by `detach`.
    const bound: Lease & { readonly port: string } = { ...reserved, name, port };
    replace(leases.map((lease) => (lease === reserved ? bound : lease)));
    try {
      await guard(bound);
    } catch (error) {
      log.info("vmd_net_attach_failed", { error: error instanceof Error ? error.message : "unknown" });
      throw new VmdFailure("failed");
    }
  }

  async function detach(name: string): Promise<void> {
    const lease = leases.find((entry) => entry.name === name);
    if (lease === undefined) return;
    // The address is only reusable once its guard is gone: a failed release keeps the lease and throws.
    await release(lease);
    replace(leases.filter((entry) => entry !== lease));
  }

  async function restore(): Promise<void> {
    const listed = await exec(psArgv());
    if (listed.code !== 0) throw new Error("net: restore cannot list the VMs");
    // Same rule as vm.list: only an explicit stop counts as stopped, so an unknown status keeps its guard.
    const running = new Set(
      parseVmList(listed.stdout)
        .filter((entry) => entry.state !== "stopped")
        .map((entry) => vmName(entry.agentId, entry.taskKey)),
    );
    const ports = await listPorts();
    if (ports === null) throw new Error("net: restore cannot list the bridge ports");
    const keep: Lease[] = [];
    for (const lease of leases) {
      if (lease.name !== null && running.has(lease.name)) keep.push(lease);
      else if (lease.name === null) continue;
      else await release(lease).catch(() => log.info("vmd_net_stale_release_failed", { ip: lease.ip }));
    }
    replace(keep);
    for (const lease of keep) {
      if (lease.port === null || !ports.includes(lease.port)) {
        log.info("vmd_net_port_missing", { ip: lease.ip });
        continue;
      }
      await guard({ ...lease, port: lease.port });
    }
    const known = new Set(keep.map((lease) => lease.name));
    for (const name of running) if (!known.has(name)) log.info("vmd_net_unknown_vm", { vm: name });
    log.info("vmd_net_restored", { vms: keep.length });
  }

  return { allocate, attach, detach, restore };
}

/** pap-vmd's start: the net with its guards back in place. It rejects when they cannot be restored, so nothing is served. */
export async function createRestoredNet(deps: NetDeps): Promise<NetPort> {
  const net = createNet(deps);
  await net.restore();
  return net;
}
