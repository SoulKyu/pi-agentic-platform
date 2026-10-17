import { chmodSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defaultProbes, makeSystemChecks } from "./checks-system.ts";
import { ctx, fake, home, probes, run, scratch, unitWith } from "../testing/doctor-fixture.ts";

describe("disk", () => {
  const free = (mb: number) => ({ statfs: () => ({ bavail: mb, bsize: 1_048_576 }) });

  it.each([
    [500, "fail"],
    [1023, "fail"],
    [1024, "warn"],
    [3071, "warn"],
    [3072, "ok"],
    [100_000, "ok"],
  ])("%i MB free against the default floor of 1024 is %s", async (mb, status) => {
    const result = await run("disk", ctx(), free(mb));
    expect(result.status).toBe(status);
    if (status !== "ok") expect(result.fix).toContain("du -sh");
  });

  it("PAP_MIN_FREE_DISK_MB moves the floor, 0 turns the check off", async () => {
    expect((await run("disk", ctx({ env: { PAP_MIN_FREE_DISK_MB: "100" } }), free(250))).status).toBe("warn");
    expect((await run("disk", ctx({ env: { PAP_MIN_FREE_DISK_MB: "100" } }), free(50))).status).toBe("fail");
    expect((await run("disk", ctx({ env: { PAP_MIN_FREE_DISK_MB: "0" } }), free(1))).status).toBe("skip");
  });

  it("the unit's value wins over the shell's, and a shell value is ignored when a unit exists without one", async () => {
    const unit = unitWith({ env: { PAP_MIN_FREE_DISK_MB: "5000" } });
    expect((await run("disk", ctx({ unit, env: { PAP_MIN_FREE_DISK_MB: "0" } }), free(2000))).status).toBe(
      "fail",
    );
    const bare = unitWith();
    expect(
      (await run("disk", ctx({ unit: bare, env: { PAP_MIN_FREE_DISK_MB: "0" } }), free(2000))).status,
    ).toBe("warn");
  });

  it("measures the nearest existing parent of a home that does not exist", async () => {
    const seen: string[] = [];
    await run("disk", ctx(), {
      statfs: (path) => {
        seen.push(path);
        if (path === home) throw Object.assign(new Error("x"), { code: "ENOENT" });
        return { bavail: 100_000, bsize: 1_048_576 };
      },
    });
    expect(seen).toEqual([home, scratch]);
  });

  it("an unreadable figure is a warn, not a pass", async () => {
    const result = await run("disk", ctx(), {
      statfs: () => {
        throw Object.assign(new Error("x"), { code: "EIO" });
      },
    });
    expect(result.status).toBe("warn");
  });
});

describe("home", () => {
  const makeHome = (mode: number, db?: number) => {
    mkdirSync(home);
    chmodSync(home, mode);
    if (db !== undefined) {
      writeFileSync(join(home, "state.db"), "x", { mode: db });
      chmodSync(join(home, "state.db"), db);
    }
  };

  it("0700 folder and 0600 database is ok and says where the home came from", async () => {
    makeHome(0o700, 0o600);
    const result = await run("home", ctx({ homeSource: "unit" }));
    expect(result.status).toBe("ok");
    expect(result.detail).toContain(`${home} (from the unit)`);
  });

  it("a home that does not exist yet is info, and is not created", async () => {
    const result = await run("home", ctx());
    expect(result.status).toBe("info");
    expect(() => statSync(home)).toThrow();
  });

  it("a 0755 folder is a warn that says it is tightened at the next start", async () => {
    makeHome(0o755, 0o600);
    const result = await run("home", ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("tightened at the next start");
    expect(result.fix).toBe(`chmod 700 ${home}`);
  });

  it("a 0644 database is a warn with its own chmod", async () => {
    makeHome(0o700, 0o644);
    const result = await run("home", ctx());
    expect(result.status).toBe("warn");
    expect(result.fix).toBe(`chmod 600 ${join(home, "state.db")}`);
  });

  it("a folder owned by another uid is a fail, even when its mode is fine", async () => {
    makeHome(0o700, 0o600);
    const real = defaultProbes().stat;
    const result = await run("home", ctx(), {
      stat: (path, follow) => {
        const found = real(path, follow);
        return found === null ? null : { ...found, uid: found.uid + 1 };
      },
    });
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("chown");
  });

  it("a home that is a file is a fail", async () => {
    writeFileSync(home, "x");
    expect((await run("home", ctx())).status).toBe("fail");
  });

  it("an unreadable home (EACCES) is a warn naming the code", async () => {
    const result = await run("home", ctx(), {
      stat: () => {
        throw Object.assign(new Error("x"), { code: "EACCES" });
      },
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("EACCES");
  });

  it("a PAP_HOME in this shell that differs from the unit's home is info", async () => {
    makeHome(0o700, 0o600);
    const unit = unitWith({ home });
    const other = await run(
      "home",
      ctx({ unit, homeSource: "unit", env: { PAP_HOME: join(scratch, "other") } }),
    );
    expect(other.status).toBe("info");
    expect(other.detail).toContain("pap commands follow the unit's home");
    const same = await run("home", ctx({ unit, homeSource: "unit", env: { PAP_HOME: home } }));
    expect(same.status).toBe("ok");
  });

  it("a warn wins over the info", async () => {
    makeHome(0o755, 0o600);
    const unit = unitWith({ home });
    const result = await run(
      "home",
      ctx({ unit, homeSource: "unit", env: { PAP_HOME: join(scratch, "o") } }),
    );
    expect(result.status).toBe("warn");
  });
});

describe("read-only", () => {
  it("running every system check leaves a home with a cleanly closed WAL database untouched", async () => {
    mkdirSync(join(home, "update"), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a')");
    db.close();
    chmodSync(join(home, "state.db"), 0o600);
    utimesSync(join(home, "state.db"), 1_700_000_000, 1_700_000_000);
    const listing = () =>
      readdirSync(home, { recursive: true })
        .map(String)
        .sort()
        .map((name) => `${name}:${statSync(join(home, name)).mtimeMs}`);
    const before = listing();
    expect(before.some((line) => line.startsWith("state.db-wal"))).toBe(false);
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    for (const check of makeSystemChecks(probes())) await check.run(ctx());
    expect(listing()).toEqual(before);
    expect(fake.calls().length).toBeGreaterThan(0);
    for (const call of fake.calls())
      expect(call).toMatch(/^(systemctl --user (show|cat|is-\w+)\b|loginctl show-user|journalctl )/);
  });
});
