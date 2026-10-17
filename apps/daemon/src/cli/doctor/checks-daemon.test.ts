import { mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ctx, home, run as runSystem, unitWith } from "../testing/doctor-fixture.ts";
import { daemonProbes } from "../testing/daemon-probes.ts";
import { makeDaemonChecks, type DaemonProbes } from "./checks-daemon.ts";
import { makeHttpsCheck, makePushCheck } from "./checks-push.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

async function run(
  id: string,
  context: DoctorContext,
  over: Partial<DaemonProbes> = {},
): Promise<CheckResult> {
  const check = makeDaemonChecks(daemonProbes(over)).find((c) => c.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check.run(context);
}

function makeDb(ids: readonly string[], wal = false): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "state.db");
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  for (const id of ids) db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  db.close();
  return path;
}

describe("schema", () => {
  it("lists nothing it does not own: the ids", () => {
    expect(makeDaemonChecks(daemonProbes()).map((c) => c.id)).toEqual([
      "schema",
      "update_pending",
      "backup",
      "bwrap",
      "python3",
      "update_available",
    ]);
  });

  it("no database yet is ok", async () => {
    const result = await run("schema", ctx());
    expect(result).toMatchObject({ status: "ok", detail: expect.stringContaining("no data yet") });
  });

  it("a current database is ok", async () => {
    makeDb(["001", "002", "003"]);
    expect((await run("schema", ctx())).status).toBe("ok");
  });

  it("pending migrations are ok and say how many and that a snapshot comes first", async () => {
    makeDb(["001"]);
    const result = await run("schema", ctx());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("2 migration(s) will run at the next start");
    expect(result.detail).toContain("a snapshot is taken first");
  });

  it("a database written by a newer pap fails with the way out", async () => {
    makeDb(["001", "999"]);
    const result = await run("schema", ctx());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("newer pap");
    expect(result.detail).toContain("read-only");
    expect(result.fix).toContain("pap restore");
    expect(result.fix).toContain("update pap");
  });

  it("garbage in place of the database fails with pap restore", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "state.db"), "this is not a database, but it is long enough ".repeat(40));
    const result = await run("schema", ctx());
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("pap restore");
  });

  it("a leftover write-ahead log with no daemon is info and the database is not opened", async () => {
    makeDb(["001", "002", "003"]);
    writeFileSync(join(home, "state.db-wal"), Buffer.alloc(64));
    const result = await run("schema", ctx({ lockHeld: false }));
    expect(result.status).toBe("info");
    expect(result.detail).toContain("applied at the next start");
  });

  it("with the daemon running, a plain read-only open reads the live database", async () => {
    const path = makeDb(["001", "002", "003"], true);
    const live = new DatabaseSync(path);
    live.exec("PRAGMA journal_mode=WAL");
    live.exec("INSERT INTO schema_migrations (id) VALUES ('003b')");
    try {
      const result = await run("schema", ctx({ lockHeld: true }));
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("newer pap");
    } finally {
      live.close();
    }
  });
});

describe("update_pending", () => {
  const pending = () => join(home, "update", "pending.json");
  const plant = (content: string | Buffer) => {
    mkdirSync(join(home, "update"), { recursive: true, mode: 0o700 });
    writeFileSync(pending(), content);
  };

  it("no file is ok", async () => {
    expect((await run("update_pending", ctx())).status).toBe("ok");
  });

  it("a valid-looking file fails with pap update recover, and says when it was written", async () => {
    plant('{"step":"switched"}');
    const result = await run("update_pending", ctx());
    expect(result.status).toBe("fail");
    expect(result.fix).toBe("pap update recover");
    expect(result.detail).toContain(pending());
  });

  it("a unit other than pap.service is named in the fix", async () => {
    plant('{"step":"switched"}');
    const result = await run("update_pending", ctx({ unitName: "pap-preview.service" }));
    expect(result.fix).toBe("pap update recover --unit pap-preview.service");
  });

  it("a file above 64 KiB is damaged, with the path", async () => {
    plant(Buffer.alloc(100 * 1024, 0x20));
    const result = await run("update_pending", ctx());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("damaged");
    expect(result.detail).toContain(pending());
    expect(result.fix).not.toBe("pap update recover");
    expect(result.fix).toContain("ls -l");
    expect(result.fix).toContain("systemctl --user status pap.service");
  });

  it("valid JSON in a file above the cap is still damaged (size, not JSON, decides)", async () => {
    plant(`{"a":"${"x".repeat(70_000)}"}`);
    expect((await run("update_pending", ctx())).detail).toContain("damaged");
  });

  it("a directory in its place is damaged", async () => {
    mkdirSync(pending(), { recursive: true });
    const result = await run("update_pending", ctx());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("damaged");
  });

  it("an unreadable update folder is a warn, not a pass", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "update"), "a file where the folder should be");
    expect((await run("update_pending", ctx())).status).toBe("warn");
  });
});

describe("update_available", () => {
  const plant = (value: unknown) => {
    mkdirSync(join(home, "update"), { recursive: true });
    writeFileSync(join(home, "update", "last-check.json"), JSON.stringify(value));
  };
  const entry = (over: Record<string, unknown> = {}) => ({
    at: "2026-10-16T08:00:00.000Z",
    channel: "stable",
    current: "1.2.0",
    latest: "1.3.0",
    status: "newer",
    ...over,
  });

  it("no check yet is skip", async () => {
    expect((await run("update_available", ctx())).status).toBe("skip");
  });

  it("a newer release is ok and names the version, the channel and the command", async () => {
    plant(entry());
    const result = await run("update_available", ctx());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("1.3.0 is available on stable: pap update install");
  });

  it.each(["current", "older"])("status %s is up to date", async (status) => {
    plant(entry({ status, latest: "1.2.0" }));
    const result = await run("update_available", ctx());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("up to date");
  });

  it.each([
    ["a bidi control in `current`", { current: "1.2.0\u202E" }],
    ["an escape in `at`", { at: "2026-10-16\u001b[31m" }],
    ["a space in `current`", { current: "1.2.0 rm" }],
  ])("%s reads as damaged and is not shown", async (_name, over) => {
    plant(entry(over));
    const result = await run("update_available", ctx());
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("unreadable");
    expect(JSON.stringify(result)).not.toContain("1.2.0");
  });

  it("a file with an extra key or a bad version is skip, and nothing from it is shown", async () => {
    plant(entry({ evil: "\u001b[31mred" }));
    const extra = await run("update_available", ctx());
    expect(extra.status).toBe("skip");
    expect(extra.detail).not.toContain("red");
    plant(entry({ latest: "1.3.0 rm -rf" }));
    expect((await run("update_available", ctx())).status).toBe("skip");
  });
});

async function listing(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = lstatSync(path);
      out.push(`${path} ${s.mode} ${s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) walk(path);
    }
  };
  out.push(`${root} ${lstatSync(root).mtimeMs}`);
  walk(root);
  return out;
}

describe("the doctor leaves no trace (M6b-RT-06)", () => {
  async function everything(over: Partial<DoctorContext> = {}) {
    const context = ctx({ unit: unitWith({ home }), ...over });
    const checks = [
      ...makeDaemonChecks(daemonProbes()),
      makeHttpsCheck(() => ({ status: "ready" })),
      makePushCheck(() => ({ status: "ready" })),
    ];
    for (const check of checks) await check.run(context);
    await runSystem("home", context);
    await runSystem("disk", context);
  }

  it("a cleanly closed WAL-mode database: listing, sizes and mtimes are identical afterwards", async () => {
    const path = makeDb(["001", "002", "003"], true);
    expect(readdirSync(home).sort()).toEqual(["state.db"]);
    const before = await listing(home);
    await everything();
    expect(await listing(home)).toEqual(before);
    expect(readdirSync(home)).not.toContain("state.db-shm");
    expect(readdirSync(home)).not.toContain("state.db-wal");
    expect(path).toContain("state.db");
  });

  it("a planted -wal is left exactly as it was and no -shm appears", async () => {
    makeDb(["001", "002", "003"], true);
    writeFileSync(join(home, "state.db-wal"), Buffer.alloc(4096, 7));
    const before = await listing(home);
    await everything();
    expect(await listing(home)).toEqual(before);
    expect(readdirSync(home)).not.toContain("state.db-shm");
  });

  it("an absent home stays absent", async () => {
    await everything();
    expect(() => lstatSync(home)).toThrow();
  });
});
