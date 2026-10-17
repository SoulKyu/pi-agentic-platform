import { describe, expect, it } from "vitest";
import { ancestorPids, runsInsideDaemon } from "./guard.ts";

const unitCgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pap.service\n";
const workerCgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1234.scope\n";

describe("runsInsideDaemon", () => {
  it("is inside when the cgroup names the unit", () => {
    expect(
      runsInsideDaemon({ cgroupText: unitCgroup, unit: "pap.service", ancestorPids: [], daemonPid: null }),
    ).toBe(true);
  });
  it("is not inside another unit's cgroup (pap-preview.service is not pap.service)", () => {
    expect(
      runsInsideDaemon({
        cgroupText: unitCgroup,
        unit: "pap-preview.service",
        ancestorPids: [],
        daemonPid: null,
      }),
    ).toBe(false);
  });
  it("a shell in a worker scope is inside only through an ancestor that is the daemon", () => {
    const base = { cgroupText: workerCgroup, unit: "pap.service" };
    expect(runsInsideDaemon({ ...base, ancestorPids: [50, 40, 4242, 1], daemonPid: 4242 })).toBe(true);
    expect(runsInsideDaemon({ ...base, ancestorPids: [50, 40, 1], daemonPid: 4242 })).toBe(false);
    expect(runsInsideDaemon({ ...base, ancestorPids: [50, 40, 1], daemonPid: null })).toBe(false);
  });
  it("an SSH shell is outside", () => {
    expect(
      runsInsideDaemon({
        cgroupText: "0::/user.slice/user-1000.slice/session-3.scope\n",
        unit: "pap.service",
        ancestorPids: [900, 1],
        daemonPid: 4242,
      }),
    ).toBe(false);
  });
});

const stat = (pid: number, ppid: number): string => `${pid} (a b) c) S ${ppid} 1 1 0`;

describe("ancestorPids", () => {
  it("follows an injected /proc table, parentheses in the name included, and stops at pid 1", () => {
    const table = new Map<number, string>([
      [300, stat(300, 200)],
      [200, stat(200, 100)],
      [100, stat(100, 1)],
    ]);
    expect(ancestorPids((pid) => table.get(pid) ?? null, 300)).toEqual([200, 100, 1]);
  });
  it("treats an unreadable stat as the end", () => {
    const table = new Map<number, string>([[300, stat(300, 200)]]);
    expect(ancestorPids((pid) => table.get(pid) ?? null, 300)).toEqual([200]);
    expect(ancestorPids(() => null, 300)).toEqual([]);
    expect(ancestorPids(() => "garbage", 300)).toEqual([]);
  });
  it("stops at 64 hops on a loop", () => {
    const chain = ancestorPids((pid) => stat(pid, pid === 5 ? 6 : 5), 5);
    expect(chain).toHaveLength(64);
  });
  it("starts from the current process by default", () => {
    const seen: number[] = [];
    ancestorPids((pid) => {
      seen.push(pid);
      return null;
    });
    expect(seen).toEqual([process.pid]);
  });
});
