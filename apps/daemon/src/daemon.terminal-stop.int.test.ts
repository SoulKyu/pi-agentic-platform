import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LINUX_PROC, sessionMembers } from "./kernel/pty/kill.ts";
import { attach, createTerminal, startWire } from "./modules/terminal/testing/wire.ts";

const pidOf = (path: string): number | null => {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};

it("stops two terminals whose shells ignore SIGHUP and whose jobs outlive them, within 10 s (RT-05)", async () => {
  const wire = await startWire();
  try {
    await wire.client.call("subscribe.terminal", {});
    const ids: string[] = [];
    const shells: number[] = [];
    const jobs: number[] = [];
    for (const n of [1, 2]) {
      const terminalId = await createTerminal(wire.client, wire.t.cwd);
      ids.push(terminalId);
      const stream = await attach(wire.client, terminalId);
      stream.type(`trap "" HUP; echo $$ > shell-${n}.pid; sleep 1000 & echo $! > job-${n}.pid; sleep 1001\r`);
    }
    await vi.waitFor(
      () => {
        for (const n of [1, 2]) {
          const shell = pidOf(join(wire.t.cwd, `shell-${n}.pid`));
          const job = pidOf(join(wire.t.cwd, `job-${n}.pid`));
          expect(shell).not.toBeNull();
          expect(job).not.toBeNull();
        }
      },
      { timeout: 15_000, interval: 20 },
    );
    for (const n of [1, 2]) {
      shells.push(pidOf(join(wire.t.cwd, `shell-${n}.pid`)) as number);
      jobs.push(pidOf(join(wire.t.cwd, `job-${n}.pid`)) as number);
    }
    const members: number[] = [];
    for (const shell of shells) {
      const found = await sessionMembers({ pid: shell, start: null, exited: Promise.resolve() }, LINUX_PROC);
      members.push(...(found ?? []));
    }
    // The two foreground `sleep 1001` are session members besides the two jobs: the walk must find them.
    expect(jobs.every((job) => members.includes(job))).toBe(true);
    expect(members.filter((pid) => !jobs.includes(pid))).toHaveLength(2);

    const started = Date.now();
    await wire.t.stop();
    expect(Date.now() - started).toBeLessThan(10_000);
    // The stop closes the terminals while the socket is still open, so a subscriber hears both (stop order, MC28 m2).
    const heard = wire.client.events.map((frame) => frame.event as { kind: string; id?: string });
    for (const id of ids) expect(heard).toContainEqual({ kind: "closed", id });
    const everyone = [...new Set([...shells, ...jobs, ...members])];
    await vi.waitFor(() => expect(everyone.filter((pid) => existsSync(`/proc/${pid}`))).toEqual([]), {
      timeout: 5000,
      interval: 20,
    });
  } finally {
    wire.client.close();
    await wire.t.stop();
  }
});
