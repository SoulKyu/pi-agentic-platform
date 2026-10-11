import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ForkedHost } from "./fork-host.ts";
import { createHostBed } from "./host-bed.ts";

// Hosts that only have a log: the bed's cleanup is under test, not a worker.
function bedWithLogs(...logs: string[]) {
  const killed: number[] = [];
  let launches = 0;
  const bed = createHostBed(() => {
    const index = launches++;
    return {
      send: () => {},
      kill: () => killed.push(index),
      exited: Promise.resolve(0),
      closed: Promise.resolve(),
      stderr: () => logs[index] ?? "",
    } as unknown as ForkedHost;
  });
  const launchAll = () => logs.forEach(() => bed.launch({ steps: [] }));
  return { bed, killed, launchAll };
}

const GUARD_LINE = 'pap-network-guard: blocked {"host":"127.0.0.1","port":9}';

describe("host bed cleanup", () => {
  it("kills every host it launched and removes its directory", async () => {
    const { bed, killed, launchAll } = bedWithLogs("", "");
    launchAll();
    await bed.dispose();
    expect(killed).toEqual([0, 1]);
    expect(existsSync(bed.root)).toBe(false);
  });

  it("fails when the first of several hosts had a connection refused, and still removes its directory", async () => {
    const { bed, launchAll } = bedWithLogs(`booting\n${GUARD_LINE}\n`, "", "");
    launchAll();
    await expect(bed.dispose()).rejects.toThrow(GUARD_LINE);
    expect(existsSync(bed.root)).toBe(false);
  });

  it("lists the refused connections of every host", async () => {
    const { bed, launchAll } = bedWithLogs(`${GUARD_LINE}\n`, `${GUARD_LINE.replace("9", "10")}\n`);
    launchAll();
    await expect(bed.dispose()).rejects.toThrow(/"port":9\}[\s\S]*"port":10\}/);
  });

  it("passes when no host was launched or none touched the network", async () => {
    await expect(bedWithLogs().bed.dispose()).resolves.toBeUndefined();
    const { bed, launchAll } = bedWithLogs("pi-host: dropped a malformed record\n");
    launchAll();
    await expect(bed.dispose()).resolves.toBeUndefined();
  });

  it("reads the logs only after the host's output is complete, which is when it closes", async () => {
    let log = "booting\n";
    const bed = createHostBed(
      () =>
        ({
          send: () => {},
          kill: () => {},
          exited: Promise.resolve(0),
          // The last of the output arrives after the exit has been reported.
          closed: new Promise<void>((resolve) =>
            setTimeout(() => {
              log += `${GUARD_LINE}\n`;
              resolve();
            }, 50),
          ),
          stderr: () => log,
        }) as unknown as ForkedHost,
    );
    bed.launch({ steps: [] });
    await expect(bed.dispose()).rejects.toThrow(GUARD_LINE);
  });

  it("does not wait for ever for a host whose output never closes", async () => {
    vi.useFakeTimers();
    try {
      const bed = createHostBed(
        () =>
          ({
            send: () => {},
            kill: () => {},
            exited: Promise.resolve(0),
            closed: new Promise<void>(() => {}),
            stderr: () => "",
          }) as unknown as ForkedHost,
      );
      bed.launch({ steps: [] });
      const disposed = bed.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(disposed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
