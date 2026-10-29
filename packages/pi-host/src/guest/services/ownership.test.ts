import { spawn } from "node:child_process";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  checkOwnership,
  listenersOn,
  ppidOf,
  procReader,
  startTimeOf,
  treeOf,
  type ProcReader,
} from "./ownership.ts";

const stat = (pid: number, comm: string, ppid: number, start = 1000 + pid): string =>
  `${pid} (${comm}) S ${ppid} ${Array(17).fill("0").join(" ")} ${start} 12345 678`;

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const hex4 = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");
const row = (local: string, state: string, inode: string): string =>
  `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 100 0 0 10 0`;
const v4 = (port: number, inode: string, address = "0100007F", state = "0A"): string =>
  row(`${address}:${hex4(port)}`, state, inode);
const v6 = (port: number, inode: string, address: string): string =>
  row(`${address}:${hex4(port)}`, "0A", inode);
const V6_LOOP = "00000000000000000000000001000000";
const V6_MAPPED = "0000000000000000FFFF00000100007F";

interface Fake {
  readonly procs: Record<number, { stat: string; fds?: string[]; v4?: string[]; v6?: string[] }>;
}
const fake = ({ procs }: Fake): ProcReader => ({
  pids: () => Object.keys(procs).map(Number),
  stat: (pid) => procs[pid]?.stat ?? null,
  fdLinks: (pid) => procs[pid]?.fds ?? [],
  tcpTables: (pid) => {
    const entry = procs[pid];
    return entry === undefined
      ? null
      : { v4: [HEADER, ...(entry.v4 ?? [])].join("\n"), v6: [HEADER, ...(entry.v6 ?? [])].join("\n") };
  },
});

/** root 10 (the outer bwrap) -> 11 (the sandbox's pid 1) -> 12 (the server); 99 is a stranger. */
const tree = (over: Partial<Fake["procs"]> = {}): Fake["procs"] => ({
  10: { stat: stat(10, "bwrap", 1) },
  11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "500")] },
  12: { stat: stat(12, "node", 11), fds: ["socket:[500]", "/dev/null"], v4: [v4(8000, "500")] },
  11000: { stat: stat(11000, "pi", 1), fds: ["socket:[900]"] },
  ...over,
});

describe("ppidOf and startTimeOf", () => {
  const odd = `42 (a b) (c) S 7 ${Array(17).fill("0").join(" ")} 31337 1 2`;
  it("ppidOf reads past a comm holding spaces and parentheses", () => {
    expect(ppidOf(odd)).toBe(7);
    expect(ppidOf("garbage")).toBeNull();
  });
  it("startTimeOf reads field 22 past a comm with spaces and parentheses", () => {
    expect(startTimeOf(odd)).toBe("31337");
    expect(startTimeOf(stat(5, "x y)", 1, 77))).toBe("77");
    expect(startTimeOf("5 (x) S 1")).toBeNull();
    expect(startTimeOf("garbage")).toBeNull();
  });
});

describe("treeOf", () => {
  it("walks the root and its descendants only", () => {
    const proc = fake({ procs: tree() });
    expect(treeOf(10, proc).sort()).toEqual([10, 11, 12]);
    expect(treeOf(11, proc).sort()).toEqual([11, 12]);
  });
  it("survives a pid that is its own parent and a cycle", () => {
    const proc = fake({
      procs: {
        10: { stat: stat(10, "a", 11) },
        11: { stat: stat(11, "b", 10) },
        12: { stat: stat(12, "c", 12) },
      },
    });
    expect(treeOf(10, proc).sort()).toEqual([10, 11]);
  });
});

describe("listenersOn", () => {
  const table = (...rows: string[]): string => [HEADER, ...rows].join("\n");
  it("reads the LISTEN rows of the port with their dial family (v4)", () => {
    const text = table(
      v4(8000, "1", "00000000"),
      v4(8000, "2", "0100007F"),
      v4(8000, "3", "0200A8C0"),
      v4(8000, "4", "0100007F", "01"),
      v4(9000, "5"),
    );
    expect(listenersOn(text, 8000, "v4")).toEqual([
      { inode: "1", via: "v4" },
      { inode: "2", via: "v4" },
      { inode: "3", via: null },
    ]);
  });
  it("reads the v6 table: any and loopback dial ::1, v4-mapped loopback dials 127.0.0.1", () => {
    const text = table(
      v6(8000, "1", "00000000000000000000000000000000"),
      v6(8000, "2", V6_LOOP),
      v6(8000, "3", V6_MAPPED),
      v6(8000, "4", "00000000000000000000000002000000"),
    );
    expect(listenersOn(text, 8000, "v6")).toEqual([
      { inode: "1", via: "v6" },
      { inode: "2", via: "v6" },
      { inode: "3", via: "v4" },
      { inode: "4", via: null },
    ]);
  });
});

describe("checkOwnership", () => {
  it("owns a port its own tree listens on, reading the namespace from the sandbox's child", () => {
    const proc = fake({ procs: tree() });
    expect(checkOwnership(10, 8000, "child", proc)).toEqual({
      owned: true,
      host: "127.0.0.1",
      nsPid: 11,
      nsStart: "1011",
    });
  });
  it("an owned port carries the start time of the namespace's pid", () => {
    const procs = tree({ 11: { stat: stat(11, "bwrap", 10, 424242), v4: [v4(8000, "500")] } });
    procs[12] = { stat: stat(12, "node", 11), fds: ["socket:[500]"] };
    expect(checkOwnership(10, 8000, "child", fake({ procs }))).toMatchObject({
      owned: true,
      nsPid: 11,
      nsStart: "424242",
    });
  });
  it("reads the namespace from the root for the plain launch", () => {
    const procs = tree({
      10: { stat: stat(10, "sh", 1), v4: [v4(8000, "500")] },
      11: { stat: stat(11, "x", 10) },
    });
    expect(checkOwnership(10, 8000, "root", fake({ procs }))).toMatchObject({ owned: true, nsPid: 10 });
    // the same data read from the child sees no listener there
    expect(checkOwnership(10, 8000, "child", fake({ procs }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
  });
  it("is gone when the namespace's pid is reused during the check, and never pins the new process", () => {
    const base = fake({ procs: tree() });
    let scanned = false;
    const reused: ProcReader = {
      ...base,
      fdLinks: (pid) => {
        scanned = true;
        return base.fdLinks(pid);
      },
      stat: (pid) => (pid === 11 && scanned ? stat(11, "bwrap", 10, 777777) : base.stat(pid)),
    };
    expect(checkOwnership(10, 8000, "child", reused)).toEqual({ owned: false, reason: "gone" });
    expect(checkOwnership(10, 8000, "child", base)).toMatchObject({ owned: true, nsStart: "1011" });
  });
  it("is port_not_owned when a stranger shares the port, and when only a stranger listens", () => {
    const shared = tree({
      12: { stat: stat(12, "node", 11), fds: ["socket:[500]"], v4: [v4(8000, "500"), v4(8000, "900")] },
    });
    expect(
      checkOwnership(
        10,
        8000,
        "root",
        fake({
          procs: { ...shared, 10: { stat: stat(10, "b", 1), v4: [v4(8000, "500"), v4(8000, "900")] } },
        }),
      ),
    ).toEqual({
      owned: false,
      reason: "port_not_owned",
    });
    const only = tree({ 11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "900")] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: only }))).toEqual({
      owned: false,
      reason: "port_not_owned",
    });
  });
  it("is not_listening with no listener, a listener on another port or state, or one bound to another address", () => {
    const none = tree({ 11: { stat: stat(11, "bwrap", 10) } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: none }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
    const otherPort = tree({ 11: { stat: stat(11, "bwrap", 10), v4: [v4(8001, "500")] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: otherPort }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
    const syn = tree({ 11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "500", "0100007F", "01")] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: syn }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
    const elsewhere = tree({ 11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "500", "0200A8C0")] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: elsewhere }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
  });
  it("is not_listening while the sandbox has no child yet, and gone when the root or its table is gone", () => {
    expect(
      checkOwnership(10, 8000, "child", fake({ procs: { 10: { stat: stat(10, "bwrap", 1) } } })),
    ).toEqual({
      owned: false,
      reason: "not_listening",
    });
    expect(checkOwnership(77, 8000, "child", fake({ procs: tree() }))).toEqual({
      owned: false,
      reason: "gone",
    });
    const noTable: ProcReader = { ...fake({ procs: tree() }), tcpTables: () => null };
    expect(checkOwnership(10, 8000, "child", noTable)).toEqual({ owned: false, reason: "gone" });
  });
  it("dials ::1 for an IPv6-only listener, and 127.0.0.1 when both are there", () => {
    const six = tree({ 11: { stat: stat(11, "bwrap", 10), v6: [v6(8000, "500", V6_LOOP)] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: six }))).toMatchObject({
      owned: true,
      host: "::1",
    });
    const mapped = tree({ 11: { stat: stat(11, "bwrap", 10), v6: [v6(8000, "500", V6_MAPPED)] } });
    expect(checkOwnership(10, 8000, "child", fake({ procs: mapped }))).toMatchObject({
      owned: true,
      host: "127.0.0.1",
    });
    const both = tree({
      11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "500")], v6: [v6(8000, "500", V6_LOOP)] },
    });
    expect(checkOwnership(10, 8000, "child", fake({ procs: both }))).toMatchObject({
      owned: true,
      host: "127.0.0.1",
    });
  });
  it("does not own a port whose only listener the guest cannot dial", () => {
    const elsewhere = tree({
      11: { stat: stat(11, "bwrap", 10), v4: [v4(8000, "500", "0200A8C0")] },
    });
    expect(checkOwnership(10, 8000, "child", fake({ procs: elsewhere }))).toEqual({
      owned: false,
      reason: "not_listening",
    });
  });
});

describe("checkOwnership on this machine's /proc", () => {
  it("owns the port a child of ours listens on, and refuses the one this test process holds", async () => {
    const script =
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1e6)";
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const mine = net.createServer();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });
      await new Promise<void>((resolve) => mine.listen(0, "127.0.0.1", resolve));
      const held = (mine.address() as net.AddressInfo).port;
      expect(child.pid).toBeGreaterThan(1);
      const proc = procReader();
      expect(checkOwnership(child.pid as number, port, "root", proc)).toMatchObject({
        owned: true,
        host: "127.0.0.1",
        nsPid: child.pid,
      });
      expect(checkOwnership(child.pid as number, held, "root", proc)).toEqual({
        owned: false,
        reason: "port_not_owned",
      });
    } finally {
      child.kill("SIGKILL");
      mine.close();
    }
  });
});
