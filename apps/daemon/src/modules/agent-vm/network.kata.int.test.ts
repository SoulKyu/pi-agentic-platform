import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createServer, connect, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NET } from "@pap/contracts";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * T20b (RT-28): the agents' network on the real stack, seen from inside the VMs as guest root outside bwrap (the probe tool).
 * Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1. T20a did the forged-frame run from a container that was
 * not in the guard's set; here the forger is a VM's own worker, and one that renames itself to the other VM's MAC and address.
 * Mutants (RT-43), each run singly on the real stack (T20b fix round 1; logs in t20b/mutant-*.log):
 *  - the bridge guard's final `counter drop` made `accept`: killed by "leaves the neighbour entry ... identity".
 *  - the IPv4/ARP guard lines made `accept` (final drop kept): killed by "leaves the neighbour entry ... identity".
 *  - the inet input rule `iifname != pap0 ... drop` removed: killed by "refuses a caller outside the VMs".
 *  - the inet input final `iifname pap0 counter drop` removed: killed by "reaches only the gateway and the relay".
 *  - the inet forward drop made accept: run, SURVIVES on a host with net.ipv4.ip_forward=0 (nothing is forwarded at all); it needs a forwarding host (T20b report).
 *  - the launch refusal for an unready relay removed: killed by "refuses a launch while a foreign socket holds the relay port".
 */
const skip = skipKata();
let bed: KataBed | undefined;
let squatter: Server | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  await new Promise<void>((resolve) => (squatter ? squatter.close(() => resolve()) : resolve()));
  squatter = undefined;
  await bed?.stop();
  bed = undefined;
});

/** Connects from this process (the host, not a VM) and resolves how it ended within `ms`. */
function hostConnect(host: string, port: number, ms = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => (socket.destroy(), resolve("timeout")), ms);
    socket.on("connect", () => (clearTimeout(timer), socket.destroy(), resolve("connected")));
    socket.on(
      "error",
      (error: NodeJS.ErrnoException) => (clearTimeout(timer), resolve(error.code ?? "error")),
    );
  });
}

/** The host's neighbour entry for `ip` on pap0: `<mac> <flags>`, or null. */
function neighbour(ip: string): string | null {
  const row = readFileSync("/proc/net/arp", "utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find((c) => c[0] === ip && c[5] === AGENT_NET.bridge);
  return row === undefined ? null : `${row[3]} ${row[2]}`;
}

/** A Python probe that tries each `host:port` for 3 s and prints `host:port=OK` or the errno name. */
const dialScript = (targets: ReadonlyArray<readonly [string, number]>, round = "DIAL"): string =>
  [
    "import socket, errno",
    `for host, port in ${JSON.stringify(targets)}:`,
    "    s = socket.socket(); s.settimeout(3)",
    "    try:",
    "        s.connect((host, port)); r = 'OK'",
    "    except socket.timeout: r = 'timeout'",
    "    except OSError as e: r = errno.errorcode.get(e.errno, str(e.errno))",
    `    print('${round} %s:%d=%s' % (host, port, r))`,
    "    s.close()",
  ].join("\n");

/** Takes `victim`'s MAC and address on eth0, dials the gateway from there, and puts `own` back. Prints `FORGED <result>`. */
const forgeScript = (victim: { ip: string; mac: string }, own: { ip: string; mac: string }): string =>
  [
    "import socket, fcntl, struct",
    "s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
    "def setmac(m): fcntl.ioctl(s.fileno(), 0x8924, struct.pack('16sH6s16s', b'eth0', 1, bytes(int(x, 16) for x in m.split(':')), b''))",
    "def setip(a): fcntl.ioctl(s.fileno(), 0x8916, struct.pack('16sHH4s16s', b'eth0', socket.AF_INET, 0, socket.inet_aton(a), b''))",
    "result = 'unset'",
    "try:",
    `    setmac(${JSON.stringify(victim.mac)}); setip(${JSON.stringify(victim.ip)})`,
    "    c = socket.socket(); c.settimeout(2)",
    "    try:",
    `        c.connect((${JSON.stringify(AGENT_NET.host)}, ${AGENT_NET.gatewayPort})); result = 'OK'`,
    "    except OSError: result = 'blocked'",
    "except OSError as e: result = 'cannot-rename:%d' % e.errno",
    "finally:",
    `    for fn in (lambda: setmac(${JSON.stringify(own.mac)}), lambda: setip(${JSON.stringify(own.ip)})):`,
    "        try: fn()",
    "        except OSError: pass",
    "print('FORGED', result)",
  ].join("\n");

/** Guest root (CAP_NET_ADMIN) adds a default route via the bridge gateway (SIOCADDRT), so its packets do reach the host's firewall. */
const ROUTE_SCRIPT = [
  "def sin(a): return struct.pack('HH4s8s', socket.AF_INET, 0, socket.inet_aton(a), b'')",
  "rt = struct.pack('@Q16s16s16sHhQPhPQQH', 0, sin('0.0.0.0'), sin('" +
    AGENT_NET.host +
    "'), sin('0.0.0.0'), 3, 0, 0, 0, 0, 0, 0, 0, 0)",
  "try:",
  "    rs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); fcntl.ioctl(rs.fileno(), 0x890B, rt); print('ROUTE=OK')",
  "except OSError as e: print('ROUTE=' + errno.errorcode.get(e.errno, '?'))",
].join("\n");

/** An address of this host that is not loopback and not the bridge's: the "LAN" leg. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const one of list ?? [])
      if (one.family === "IPv4" && !one.internal && !one.address.startsWith("10.213.")) return one.address;
  throw new Error("this host has no LAN address");
}

const IDENTITY = [
  "import socket, fcntl, struct",
  "s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
  "ifr = struct.pack('256s', b'eth0')",
  "ip = socket.inet_ntoa(fcntl.ioctl(s.fileno(), 0x8915, ifr)[20:24])",
  "mac = ':'.join('%02x' % b for b in fcntl.ioctl(s.fileno(), 0x8927, ifr)[18:24])",
  "print('IDENT', ip, mac)",
].join("\n");

async function identity(
  b: KataBed,
  agentId: string,
  sessionId: string,
): Promise<{ ip: string; mac: string }> {
  const match = /IDENT (\S+) (\S+)/.exec(await b.python(agentId, sessionId, IDENTITY));
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("the VM did not tell its identity");
  return { ip: match[1], mac: match[2] };
}

describe.skipIf(skip)("the agents' network on the real stack", () => {
  it(
    "reaches only the gateway and the relay, from a VM; a raw socket is refused",
    async () => {
      bed = await startKataBed();
      // A port nothing in pap uses, open on the bridge address: a VM must still not reach it (the bridge's final drop).
      squatter = createServer();
      await new Promise<void>((resolve) => squatter?.listen(0, "0.0.0.0", resolve));
      const lan = lanAddress();
      const spare = (squatter.address() as { port: number }).port;
      const a = await bed.createAgent({ name: "Alpha" });
      const b = await bed.createAgent({ name: "Bravo" });
      const sa = await bed.openThread(a);
      const sb = await bed.openThread(b);
      const other = await identity(bed, b, sb);
      const outside = [
        ["172.17.0.1", 80],
        ["192.168.1.1", 80],
        ["1.1.1.1", 443],
        [lan, spare],
      ] as const;
      const out = await bed.python(
        a,
        sa,
        [
          "import fcntl, struct",
          dialScript([
            [AGENT_NET.host, AGENT_NET.gatewayPort],
            [AGENT_NET.host, AGENT_NET.relayPort],
            [AGENT_NET.host, 22],
            [AGENT_NET.host, spare],
            [other.ip, AGENT_NET.gatewayPort],
            ...outside,
          ]),
          "try:",
          "    socket.socket(socket.AF_PACKET, socket.SOCK_RAW)",
          "    print('RAW=OK')",
          "except OSError as e: print('RAW=' + errno.errorcode.get(e.errno, '?'))",
          ROUTE_SCRIPT,
          dialScript(outside, "ROUTED"),
        ].join("\n"),
      );
      const leg = (round: string, host: string, port: number): string =>
        new RegExp(`${round} ${host.replaceAll(".", "\\.")}:${port}=(\\S+)`).exec(out)?.[1] ?? "missing";
      expect(leg("DIAL", AGENT_NET.host, AGENT_NET.gatewayPort)).toBe("OK");
      expect(leg("DIAL", AGENT_NET.host, AGENT_NET.relayPort)).toBe("OK");
      for (const [host, port] of [
        [AGENT_NET.host, 22],
        [AGENT_NET.host, spare],
        [other.ip, AGENT_NET.gatewayPort],
      ] as const)
        expect(leg("DIAL", host, port), `${host}:${port}`).not.toBe("OK");
      // With no route the guest cannot even send; with a default route via the gateway its packets reach the host and its firewall
      // drops them (a timeout, never a connection or a refusal), the host's own LAN address included.
      expect(out).toContain("RAW=EPERM");
      expect(out).toContain("ROUTE=OK");
      for (const [host, port] of outside) {
        expect(leg("DIAL", host, port), `${host}:${port} unrouted`).toBe("ENETUNREACH");
        expect(leg("ROUTED", host, port), `${host}:${port} routed`).toBe("timeout");
      }
      process.stderr.write(`T20b network, seen from VM Alpha:\n${out}\n`);
    },
    LONG_MS,
  );

  it(
    "refuses a caller outside the VMs: this process cannot reach the gateway or the relay",
    async () => {
      bed = await startKataBed();
      for (const port of [AGENT_NET.gatewayPort, AGENT_NET.relayPort])
        expect(await hostConnect(AGENT_NET.host, port), `port ${port}`).toBe("timeout");
    },
    LONG_MS,
  );

  it(
    "leaves the neighbour entry and the other VM's channel intact when a VM takes the other VM's identity",
    async () => {
      bed = await startKataBed();
      const a = await bed.createAgent({ name: "Alpha" });
      const b = await bed.createAgent({ name: "Bravo" });
      const sa = await bed.openThread(a);
      const sb = await bed.openThread(b);
      const victim = await identity(bed, b, sb);
      const own = await identity(bed, a, sa);
      const before = neighbour(victim.ip);
      expect(before).toMatch(/^\S+ 0x[0-9a-f]+$/);
      // VM A renames itself to B's MAC and address for 2 s (it holds CAP_NET_ADMIN), asks the gateway for a connection from
      // that identity, and puts its own back. The bridge guard drops the frames of a port whose MAC and address are not its own.
      const forged = await bed.python(a, sa, forgeScript(victim, own));
      // Either the guest may not rename itself (the finding is then that it cannot forge) or the guard blocked the connection.
      process.stderr.write(`T20b identity change in VM Alpha: ${forged.trim()}\n`);
      expect(forged).toMatch(/FORGED (blocked|cannot-rename:\d+)/);
      expect(forged).not.toContain("FORGED OK");
      expect(neighbour(victim.ip)).toBe(before);
      // B still has its channel: it answers a probe and reaches the gateway.
      const still = await bed.python(b, sb, dialScript([[AGENT_NET.host, AGENT_NET.gatewayPort]]));
      expect(still).toContain(`DIAL ${AGENT_NET.host}:${AGENT_NET.gatewayPort}=OK`);
    },
    LONG_MS,
  );

  it(
    "refuses a launch while a foreign socket holds the relay port, and launches once it is gone (AVM-E49 M9b)",
    async () => {
      squatter = createServer();
      await new Promise<void>((resolve, reject) => {
        squatter?.once("error", reject);
        squatter?.listen(AGENT_NET.relayPort, AGENT_NET.host, resolve);
      });
      bed = await startKataBed({ awaitRelay: false });
      const agentId = await bed.createAgent({ name: "Charlie" });
      await expect(bed.openThread(agentId)).rejects.toThrow();
      expect(bed.starts).toEqual([]);
      await new Promise<void>((resolve) => squatter?.close(() => resolve()));
      squatter = undefined;
      await bed.vm.relay?.whenReady();
      const sessionId = await bed.openThread(agentId);
      expect(sessionId).toMatch(/\S/);
      expect(bed.starts).toHaveLength(1);
    },
    LONG_MS,
  );
});
