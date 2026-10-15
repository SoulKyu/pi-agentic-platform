import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createAdmission, FORK_CAP } from "./fork-quota.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const MB = 1_048_576;
const admissionOf =
  (freeMb: number, minFreeDiskMb = 1024) =>
  (clock: Parameters<typeof createAdmission>[0]["clock"]) =>
    createAdmission({
      clock,
      logger: silentLogger,
      sessionsDir: "/x",
      minFreeDiskMb,
      statfs: () => ({ bavail: freeMb, bsize: MB }),
    });

async function session(options: BedOptions) {
  bed = build(options);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const file = bed.writePiFile(0, [
    ["q0", "r0"],
    ["q1", "r1"],
  ]);
  bed.store.bindPiFile(sessionId, file, "pi-0");
  return { sessionId, file };
}
const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };
const filesIn = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".jsonl"));

describe("fork and clone caps", () => {
  it("refuse the 31st fork or clone of an owner with rate_limited, before a file is written", async () => {
    const { sessionId, file } = await session({ admission: admissionOf(5000) });
    for (let i = 0; i < FORK_CAP; i++) {
      if (i % 2 === 0) await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
      else await bed.service.clone({ sessionId }, OWNER);
    }
    const before = filesIn(bed.sessionsDir).length;
    expect(await codeOf(bed.service.fork({ sessionId, entryId: "u1" }, OWNER))).toBe("rate_limited");
    expect(await codeOf(bed.service.clone({ sessionId }, OWNER))).toBe("rate_limited");
    expect(filesIn(bed.sessionsDir)).toHaveLength(before);
    expect(readFileSync(file, "utf8")).toContain("q1");
  });

  it("hold when forks run at the same time: exactly 30 of 40 pass", async () => {
    const { sessionId } = await session({ admission: admissionOf(5000) });
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => bed.service.clone({ sessionId }, OWNER)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(FORK_CAP);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused.map((r) => (r.reason as PapError).code)).toEqual(Array(10).fill("rate_limited"));
  });
});

describe("disk floor", () => {
  it("refuses fork and clone with disk_low before any file is written, the temporary folder empty", async () => {
    const { sessionId } = await session({ admission: admissionOf(10) });
    const before = filesIn(bed.sessionsDir);
    expect(await codeOf(bed.service.fork({ sessionId, entryId: "u1" }, OWNER))).toBe("disk_low");
    expect(await codeOf(bed.service.clone({ sessionId }, OWNER))).toBe("disk_low");
    expect(filesIn(bed.sessionsDir)).toEqual(before);
    expect(existsSync(bed.forkTmpDir) ? readdirSync(bed.forkTmpDir) : []).toEqual([]);
  });

  it("refuses createTaskSession with disk_low before a worker starts", async () => {
    bed = build({ admission: admissionOf(10) });
    expect(
      await codeOf(
        bed.service.automation.createTaskSession({ ownerId: "u1", cwd: bed.work, policy: POLICY }),
      ),
    ).toBe("disk_low");
    expect(bed.spawned).toHaveLength(0);
  });

  it("lets createTaskSession through above the floor", async () => {
    bed = build({ admission: admissionOf(5000) });
    await bed.service.automation.createTaskSession({ ownerId: "u1", cwd: bed.work, policy: POLICY });
    expect(bed.spawned).toHaveLength(1);
  });
});
