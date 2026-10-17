import { chmodSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harness, type Ctl, type Harness } from "../testing/apply-harness.ts";
import { runCommand, seamsFor } from "../testing/update-ops.ts";
import { applyRelease, type ApplyOutcome } from "./apply.ts";
import { makeApplyCommand } from "./apply-command.ts";
import { readPending } from "./pending.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const THIS_RUN = "pre-update-new-2026-10-17T10-00-00-000Z.db";
const OLD = (day: number): string => `pre-update-r${day}-2026-10-0${day}T00-00-00-000Z.db`;

function oldSnapshots(env: Harness, days: number[]): void {
  mkdirSync(join(env.home, "backups"), { recursive: true });
  for (const day of days) {
    const path = join(env.home, "backups", OLD(day));
    writeFileSync(path, "x");
    const at = new Date(Date.UTC(2000, 0, day));
    utimesSync(path, at, at);
  }
}
const kept = (env: Harness): string[] =>
  readdirSync(join(env.home, "backups"))
    .filter((name) => name.startsWith("pre-update-"))
    .sort();

async function apply(env: Harness, apply: typeof applyRelease = applyRelease) {
  const { seams } = seamsFor(env);
  return runCommand(makeApplyCommand({ ...seams, apply }), ["--release", "new", "--app-root", env.app]);
}
const go = (ctl: Partial<Ctl> = {}, days = [1, 2, 3, 4, 5]) => {
  h = harness({ ctl });
  return { env: h, days };
};

describe("M6b-C3: the three newest snapshots are kept after a successful update", () => {
  it("removes the older ones, keeps this run's snapshot and the two newest before it", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    const result = await apply(env);
    expect(result.code, result.err).toBe(0);
    expect(kept(env)).toEqual([OLD(4), OLD(5), THIS_RUN].sort());
    expect(result.out).toContain(`database snapshot: backups/${THIS_RUN} (kept; the three newest are kept)`);
  });

  it("an unverified update (exit 3) prunes as well", async () => {
    const { env, days } = go({ listening: [{ kind: "unreadable" }] });
    oldSnapshots(env, days);
    expect((await apply(env)).code).toBe(3);
    expect(kept(env)).toHaveLength(3);
  });

  it("a rolled back update removes nothing", async () => {
    const { env, days } = go({ healthz: [false] });
    oldSnapshots(env, days);
    expect((await apply(env)).code).toBe(4);
    expect(kept(env)).toHaveLength(6);
  });

  it("a refused update (exit 1) removes nothing", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    const result = await apply(env, async () => {
      throw new (await import("./apply.ts")).ApplyRefused("nope");
    });
    expect(result.code).toBe(1);
    expect(kept(env)).toHaveLength(5);
  });

  it("never removes the snapshot a live pending.json names", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    // a journal that outlives the command: written by the stubbed apply, which reports success without clearing it
    const result = await apply(env, async (deps) => {
      const outcome = await applyRelease(deps, "new");
      const { writePending } = await import("./pending.ts");
      writePending(env.home, {
        format: 1,
        from: "old",
        to: "new",
        step: "rolling_back",
        snapshot: OLD(1),
        schemaBefore: ["001"],
        startedAt: "2026-10-17T10:00:00.000Z",
      });
      return outcome;
    });
    expect(result.code, result.err).toBe(0);
    expect(readPending(env.home)).not.toBeNull();
    expect(kept(env)).toContain(OLD(1));
  });

  it("the snapshot line names the snapshot of THIS run, not the newest name with the same prefix", async () => {
    const { env } = go();
    mkdirSync(join(env.home, "backups"), { recursive: true });
    const stub: ApplyOutcome = { kind: "updated", snapshot: "pre-update-new-2026-10-17T10-00-00-000Z.db" };
    writeFileSync(join(env.home, "backups", "pre-update-new-2099-01-01T00-00-00-000Z.db"), "x");
    const result = await apply(env, async () => stub);
    expect(result.out).toContain("backups/pre-update-new-2026-10-17T10-00-00-000Z.db (kept");
    expect(result.out).not.toContain("2099");
  });

  it("no snapshot in the outcome: no snapshot line", async () => {
    const { env } = go();
    mkdirSync(join(env.home, "backups"), { recursive: true });
    writeFileSync(join(env.home, "backups", "pre-update-new-2099-01-01T00-00-00-000Z.db"), "x");
    const result = await apply(env, async () => ({ kind: "updated", snapshot: null }));
    expect(result.out).not.toContain("database snapshot");
  });
});

describe.skipIf(process.getuid?.() === 0)("a prune that fails does not fail the update, and says so", () => {
  afterEach(() => {
    if (h !== undefined) chmodSync(join(h.home, "backups"), 0o700);
  });
  const ok = async () => ({ kind: "updated", snapshot: null }) as const;

  it("an undeletable snapshot: exit 0 and one stderr line naming it", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    chmodSync(join(env.home, "backups"), 0o500);
    const result = await apply(env, ok);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("pap: could not remove old snapshot(s) ");
    expect(result.err).toContain(OLD(1));
    expect(result.err.trimEnd().split("\n")).toHaveLength(1);
  });

  it("an unreadable backups folder: exit 0 and a line about listing it", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    chmodSync(join(env.home, "backups"), 0o000);
    const result = await apply(env, ok);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("pap: could not list backups/");
  });

  it("a clean prune prints nothing on stderr", async () => {
    const { env, days } = go();
    oldSnapshots(env, days);
    expect((await apply(env, ok)).err).toBe("");
  });
});
