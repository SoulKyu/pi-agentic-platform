import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeListenerFault,
  type Endpoint,
  ownerOf,
  ownsListener,
  parseListeners,
  type ProcReader,
  realProcReader,
  socketInodes,
} from "./listener-owner.ts";

/*
 * AVM-E49 M9b. Mutants (RT-43), each run for real:
 *  - `every` made `some` (one own socket among foreign ones counts) -> killed by "a foreign socket beside its own".
 *  - the inode match dropped (a socket on the port counts as owned) -> killed by "a foreign listener".
 *  - the try/catch of bridgeListenerFault removed -> killed by "is a fault, not a throw".
 *  - the wildcard rows ignored -> killed by "a wildcard listener".
 *  - `/proc/net/tcp6` not read -> killed by "a dual-stack listener" (both cases); the v4-mapped form not decoded -> killed by
 *    "a v4-mapped row".
 */
const GATEWAY: Endpoint = { host: "10.213.0.1", port: 7842 };
// 10.213.0.1 is 0x0100D50A little-endian; 7842 is 0x1EA2.
const row = (host: string, port: string, state: string, inode: number): string =>
  `   0: ${host}:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function fake(rows: string[], fds: Record<number, string[]>, rows6: string[] = []): ProcReader {
  return {
    tcp: () => [HEADER, ...rows].join("\n"),
    tcp6: () => [HEADER, ...rows6].join("\n"),
    fdTargets: (pid) => fds[pid] ?? [],
    pids: () => Object.keys(fds).map(Number),
    parentOf: () => null,
  };
}

describe("the listeners of /proc/net/tcp", () => {
  it("reads LISTEN rows only, with a little-endian address", () => {
    const listeners = parseListeners(
      [HEADER, row("0100D50A", "1EA2", "0A", 555), row("0100D50A", "1EA2", "01", 556)].join("\n"),
    );
    expect(listeners).toEqual([{ host: "10.213.0.1", port: 7842, inode: 555 }]);
  });

  it("takes the inodes of socket fds and nothing else", () => {
    expect(socketInodes(["socket:[12]", "pipe:[13]", "/dev/null", "anon_inode:[eventpoll]"])).toEqual(
      new Set([12]),
    );
  });
});

describe("the listeners of /proc/net/tcp6 (T20b M6)", () => {
  const WILD6 = "00000000000000000000000000000000";
  // ::ffff:10.213.0.1 prints as the words 00000000 00000000 0000FFFF(LE: FFFF0000) 0100D50A(LE).
  const MAPPED6 = "0000000000000000FFFF00000100D50A";
  const OTHER6 = "000080FE00000000FF7B1AFE01000000";

  it("reads a wildcard row as the wildcard, a v4-mapped row as its address, and leaves any other v6 address out", () => {
    const text = [
      HEADER,
      row(WILD6, "1EA2", "0A", 1),
      row(MAPPED6, "1EA2", "0A", 2),
      row(OTHER6, "1EA2", "0A", 3),
    ];
    expect(parseListeners(text.join("\n"), true)).toEqual([
      { host: "0.0.0.0", port: 7842, inode: 1 },
      { host: "10.213.0.1", port: 7842, inode: 2 },
      { host: "", port: 7842, inode: 3 },
    ]);
  });

  it("sees a dual-stack listener on the port that tcp alone misses", () => {
    const proc = fake([], { 40: ["socket:[1]"], 41: ["socket:[5]"] }, [row(WILD6, "1EA2", "0A", 5)]);
    expect(ownerOf(proc, GATEWAY)).toEqual({ listening: true, pid: 41 });
    expect(ownsListener(proc, 40, GATEWAY).owned).toBe(false);
  });

  it("sees a v4-mapped row of the bridge address, and keeps working on a host without tcp6", () => {
    const proc = fake([], { 41: ["socket:[6]"] }, [row(MAPPED6, "1EA2", "0A", 6)]);
    expect(ownerOf(proc, GATEWAY)).toEqual({ listening: true, pid: 41 });
    const noV6: ProcReader = { ...proc, tcp6: () => "" };
    expect(ownerOf(noV6, GATEWAY)).toEqual({ listening: false, pid: null });
    const bare: ProcReader = {
      tcp: proc.tcp,
      fdTargets: proc.fdTargets,
      pids: proc.pids,
      parentOf: proc.parentOf,
    };
    expect(ownerOf(bare, GATEWAY)).toEqual({ listening: false, pid: null });
  });
});

describe("ownsListener", () => {
  it("is true for its own listener", () => {
    const proc = fake([row("0100D50A", "1EA2", "0A", 555)], { 40: ["socket:[555]"] });
    expect(ownsListener(proc, 40, GATEWAY)).toEqual({ owned: true });
  });

  it("is false for a foreign listener", () => {
    const proc = fake([row("0100D50A", "1EA2", "0A", 555)], { 40: ["socket:[1]"], 41: ["socket:[555]"] });
    expect(ownsListener(proc, 40, GATEWAY).owned).toBe(false);
  });

  it("is false for a foreign socket beside its own", () => {
    const proc = fake([row("0100D50A", "1EA2", "0A", 555), row("0100D50A", "1EA2", "0A", 556)], {
      40: ["socket:[555]"],
    });
    expect(ownsListener(proc, 40, GATEWAY).owned).toBe(false);
  });

  it("is false for a wildcard listener on the port", () => {
    const proc = fake([row("00000000", "1EA2", "0A", 777)], { 40: ["socket:[1]"] });
    expect(ownsListener(proc, 40, GATEWAY)).toEqual({
      owned: false,
      reason: "a socket that is not the process's own listens there",
    });
  });

  it("is false when nothing listens, and ignores other ports and addresses", () => {
    const proc = fake([row("0100D50A", "1EA1", "0A", 1), row("0200D50A", "1EA2", "0A", 2)], {
      40: ["socket:[1]", "socket:[2]"],
    });
    expect(ownsListener(proc, 40, GATEWAY)).toEqual({ owned: false, reason: "no socket listens there" });
  });
});

describe("bridgeListenerFault", () => {
  // 7841 is 0x1EA1, 7842 is 0x1EA2.
  const rows = [row("0100D50A", "1EA1", "0A", 100), row("0100D50A", "1EA2", "0A", 200)];
  it("is null when the daemon holds the gateway and its child the relay", () => {
    expect(bridgeListenerFault(fake(rows, { 1: ["socket:[100]"], 2: ["socket:[200]"] }), 1, 2)).toBeNull();
  });
  it("is a fault, not a throw, when /proc cannot be read (M-throw)", () => {
    const broken: ProcReader = {
      ...fake(rows, { 1: ["socket:[100]"], 2: ["socket:[200]"] }),
      tcp: () => {
        throw new Error("EIO");
      },
    };
    expect(bridgeListenerFault(broken, 1, 2)).toBe("the listening sockets could not be read from /proc");
  });
  it("names the gateway or the relay when a socket is not theirs, and a child without a pid", () => {
    expect(bridgeListenerFault(fake(rows, { 1: [], 2: ["socket:[200]"] }), 1, 2)).toContain("gateway");
    expect(bridgeListenerFault(fake(rows, { 1: ["socket:[100]"], 3: ["socket:[200]"] }), 1, 2)).toContain(
      "relay",
    );
    expect(bridgeListenerFault(fake(rows, { 1: ["socket:[100]"] }), 1, undefined)).toContain("no pid");
  });
});

describe("ownerOf", () => {
  it("finds the process that holds the listening socket", () => {
    const proc = fake([row("0100D50A", "1EA2", "0A", 555)], { 7: [], 40: ["socket:[555]"] });
    expect(ownerOf(proc, GATEWAY)).toEqual({ listening: true, pid: 40 });
  });
  it("says so when nobody visible holds it, or nobody listens", () => {
    expect(ownerOf(fake([row("0100D50A", "1EA2", "0A", 555)], { 7: [] }), GATEWAY)).toEqual({
      listening: true,
      pid: null,
    });
    expect(ownerOf(fake([], { 7: [] }), GATEWAY)).toEqual({ listening: false, pid: null });
  });
});

describe("the real /proc", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("sees this process's own listener as owned, and anyone else's as foreign", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const proc = realProcReader();
    const here: Endpoint = { host: "127.0.0.1", port };
    expect(ownsListener(proc, process.pid, here)).toEqual({ owned: true });
    expect(ownsListener(proc, process.ppid, here).owned).toBe(false);
    expect(ownerOf(proc, here)).toEqual({ listening: true, pid: process.pid });
    expect(proc.parentOf(process.pid)).toBe(process.ppid);
  });
});
