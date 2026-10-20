import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ctx, home } from "../testing/doctor-fixture.ts";
import { defaultVmProbes } from "./checks-vm.ts";

/*
 * Mutants (RT-43), each run for real in the T18 report:
 *  - M-default: an agent with no `resources` counts 0 -> "sums the disks" fails.
 *  - M-follow: the kept-mirror walk uses `statSync` -> "does not follow a link" fails.
 */
const reserved = () => defaultVmProbes().reserved(ctx());

function agentsDb(profiles: readonly object[]): void {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE agents (id TEXT, profile TEXT)");
  profiles.forEach((profile, i) =>
    db.prepare("INSERT INTO agents VALUES (?, ?)").run(`agent-${i}`, JSON.stringify(profile)),
  );
  db.close();
}

describe("the reserved room of the agents (vm.disk)", () => {
  it("is zero without a database or mirrors", () => {
    expect(reserved()).toEqual({ agentDisksMb: 0, keptMirrorsMb: 0 });
  });

  it("sums the agents' disks, 4096 for a profile that names none (M-default)", () => {
    agentsDb([{ resources: { memoryMb: 1024, cpus: 1, diskMb: 8192 } }, {}, { resources: { diskMb: 2048 } }]);
    expect(reserved().agentDisksMb).toBe(8192 + 4096 + 2048);
  });

  it("adds the files under replaced/ of each agent's mirrors, rounded up, and follows no link (M-follow)", () => {
    const kept = join(home, "agents", ".mirrors", "helper-1a2b", "replaced");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "s.jsonl.1700000000000"), Buffer.alloc(1024 ** 2 + 1));
    const outside = join(home, "outside.bin");
    writeFileSync(outside, Buffer.alloc(50 * 1024 ** 2));
    symlinkSync(outside, join(kept, "s.jsonl.1700000000001"));
    // The live mirror is not a kept copy.
    writeFileSync(join(home, "agents", ".mirrors", "helper-1a2b", "s.jsonl"), Buffer.alloc(10 * 1024 ** 2));
    expect(reserved().keptMirrorsMb).toBe(2);
  });
});
