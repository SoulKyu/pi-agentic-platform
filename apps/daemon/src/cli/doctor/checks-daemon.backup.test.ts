import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { daemonProbes } from "../testing/daemon-probes.ts";
import { ctx, home } from "../testing/doctor-fixture.ts";
import { makeDaemonChecks } from "./checks-daemon.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const check = () => {
  const found = makeDaemonChecks(daemonProbes()).find((c) => c.id === "backup");
  if (found === undefined) throw new Error("no backup check");
  return found;
};
const context = () => ctx({ clock: createFakeClock(NOW) });

const plant = (value: unknown) => {
  mkdirSync(join(home, "update"), { recursive: true });
  writeFileSync(
    join(home, "update", "last-backup.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
const entry = (over: Record<string, unknown> = {}) => ({
  createdAt: new Date(NOW - 2 * DAY).toISOString(),
  file: "pap-backup-20261015T120000Z.tar.gz.enc",
  encrypted: true,
  secrets: "excluded",
  ...over,
});
function sparse(name: string, bytes: number): void {
  mkdirSync(join(home, "backups"), { recursive: true });
  const fd = openSync(join(home, "backups", name), "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

describe("backup", () => {
  it("no backup made is info, never warn (a healthy install exits 0), with the command", async () => {
    const result = await check().run(context());
    expect(result.status).toBe("info");
    expect(result.detail).toContain("no backup made with `pap backup`");
    expect(result.fix).toBe("pap backup");
  });

  it("a backup of 31 days ago warns with the age", async () => {
    plant(entry({ createdAt: new Date(NOW - 31 * DAY).toISOString() }));
    const result = await check().run(context());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("31 days");
    expect(result.fix).toBe("pap backup");
  });

  it("30 days exactly is still ok", async () => {
    plant(entry({ createdAt: new Date(NOW - 30 * DAY).toISOString() }));
    expect((await check().run(context())).status).toBe("ok");
  });

  it("a recent encrypted backup is ok and says encrypted and without secrets", async () => {
    plant(entry());
    const result = await check().run(context());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("2 days ago");
    expect(result.detail).toContain("encrypted");
    expect(result.detail).toContain("secrets not included");
  });

  it("a plain backup with secrets says so", async () => {
    plant(entry({ encrypted: false, secrets: "included" }));
    const result = await check().run(context());
    expect(result.detail).toContain("not encrypted");
    expect(result.detail).toContain("secrets included");
  });

  it("a date in the future (clock skew) is not an old backup", async () => {
    plant(entry({ createdAt: new Date(NOW + 5 * DAY).toISOString() }));
    expect((await check().run(context())).status).toBe("ok");
  });

  it.each([
    ["not JSON", "{nope"],
    ["an extra key", JSON.stringify({ ...entry(), extra: 1 })],
    ["a missing key", JSON.stringify({ createdAt: entry().createdAt })],
    ["a date that is not one", JSON.stringify(entry({ createdAt: "yesterday" }))],
    [
      "the old key `at`",
      JSON.stringify({ at: entry().createdAt, file: entry().file, encrypted: true, secrets: false }),
    ],
    ["secrets as a boolean", JSON.stringify(entry({ secrets: false }))],
    ["a bidi control in the file name", JSON.stringify(entry({ file: "pap-backup-\u202Eexe.tar.gz" }))],
    ["an escape sequence in the file name", JSON.stringify(entry({ file: "pap-backup-\u001b[2J.tar.gz" }))],
    ["a file name of 10 000 characters", JSON.stringify(entry({ file: "x".repeat(10_000) }))],
  ])("a damaged record (%s) warns and does not pass", async (_name, content) => {
    plant(content);
    const result = await check().run(context());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("unreadable");
    expect(result.detail).not.toContain("202E");
    expect(JSON.stringify(result)).not.toContain("pap-backup-");
  });

  it('T3\'s record, field for field, reads as a backup (createdAt, file, encrypted, secrets "excluded")', async () => {
    plant({
      createdAt: "2026-10-16T12:00:00.000Z",
      file: "pap-backup-20261016T120000Z.tar.gz",
      encrypted: false,
      secrets: "excluded",
    });
    const result = await check().run(context());
    expect(result.status).toBe("ok");
    expect(result.detail).toBe(
      "last backup 1 day ago (pap-backup-20261016T120000Z.tar.gz); not encrypted, secrets not included",
    );
  });

  it("30 days and 23 hours is stale: the age is compared in milliseconds, not whole days", async () => {
    plant(entry({ createdAt: new Date(NOW - 30 * DAY - 23 * 3_600_000).toISOString() }));
    const result = await check().run(context());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("30 days");
    plant(entry({ createdAt: new Date(NOW - 30 * DAY - 1).toISOString() }));
    expect((await check().run(context())).status).toBe("warn");
  });

  it("a backups folder that cannot be read is an info line, not silence", async () => {
    plant(entry());
    writeFileSync(join(home, "backups"), "a file where the folder should be");
    const result = await check().run(context());
    expect(result.status).toBe("info");
    expect(result.detail).toContain("cannot read");
    expect(result.detail).toContain("ENOTDIR");
    expect(result.fix).toContain("ls -ld");
  });

  it("backups written with --out elsewhere are not counted", async () => {
    plant(entry());
    expect((await check().run(context())).detail).not.toContain("GiB");
  });

  it("3 GiB of pap-backup files adds the --keep hint and info", async () => {
    plant(entry());
    for (const n of [1, 2, 3]) sparse(`pap-backup-2026101${n}T120000Z.tar.gz`, 1024 ** 3);
    const result = await check().run(context());
    expect(result.status).toBe("info");
    expect(result.detail).toContain("3.0 GiB");
    expect(result.fix).toContain("--keep");
  });

  it("other names in backups/ are not counted, and 2 GiB exactly is quiet", async () => {
    plant(entry());
    sparse("pap-backup-20261011T120000Z.tar.gz", 2 * 1024 ** 3);
    sparse("pre-restore-20261011.db", 5 * 1024 ** 3);
    expect((await check().run(context())).status).toBe("ok");
  });

  it("a warn stays a warn when the folder is big, and both show", async () => {
    plant(entry({ createdAt: new Date(NOW - 40 * DAY).toISOString() }));
    sparse("pap-backup-20260901T120000Z.tar.gz", 3 * 1024 ** 3);
    const result = await check().run(context());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("40 days");
    expect(result.detail).toContain("3.0 GiB");
  });

  it("creates nothing: a home with no backups/ folder keeps none", async () => {
    await check().run(context());
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(home)).toBe(false);
  });
});
