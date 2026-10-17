import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSystemd } from "./testing/fake-systemd.ts";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const ALLOWED_CALL =
  /^(systemctl --user (show|cat|is-\w+|show-environment)\b|loginctl show-user|journalctl )/;

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let home: string;
let papHome: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-doctor-int-"));
  fake = fakeSystemd(join(scratch, "fake"));
  home = join(scratch, "home");
  papHome = join(scratch, "pap-home");
  mkdirSync(home);
  mkdirSync(join(papHome, "update"), { recursive: true, mode: 0o700 });
  writeFileSync(join(papHome, "state.db"), "not a database", { mode: 0o600 });
  env = {
    PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    PAP_HOME: papHome,
    PAP_MIN_FREE_DISK_MB: "1",
  };
  fake.set("linger", "yes\n");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const pap = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN, "doctor", ...args],
    { env, encoding: "utf8", timeout: 55_000 },
  );
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((name) => {
      const stat = statSync(join(dir, name));
      return `${name} ${stat.mode.toString(8)} ${stat.size} ${stat.mtimeMs}`;
    });

describe("pap doctor (spawned CLI, fake systemd, temporary home)", () => {
  it("a healthy machine exits 0, prints the header and one line per check, and changes nothing", () => {
    const before = [snapshot(papHome), snapshot(home)];
    const r = pap("--only", "node,toolchain,user_manager,linger,disk,home");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`home: ${papHome} (from the environment)`);
    expect(r.stdout).toMatch(/^\[ok\] node /m);
    expect(r.stdout).toMatch(/^\[ok\] home /m);
    expect([snapshot(papHome), snapshot(home)]).toEqual(before);
  });

  it("--json parses, lists every registered check and adds no ANSI", () => {
    const r = pap("--json");
    // the planted garbage state.db makes `schema` fail, so 1 is expected here
    expect([0, 1, 2]).toContain(r.status);
    expect(r.stdout).not.toContain("\u001b");
    const report = JSON.parse(r.stdout) as { exit: number; results: Array<{ id: string; status: string }> };
    expect(report.exit).toBe(r.status);
    expect(report.results.map((x) => x.id)).toEqual([
      "node",
      "toolchain",
      "user_manager",
      "linger",
      "journal",
      "disk",
      "home",
      "schema",
      "update_pending",
      "backup",
      "https",
      "push",
      "bwrap",
      "python3",
      "update_available",
    ]);
  });

  it("a healthy default install exits 0 for the state checks: no backup yet is info, never warn", () => {
    rmSync(join(papHome, "state.db"));
    const before = snapshot(papHome);
    const r = pap("--only", "schema,update_pending,backup,update_available");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\[ok\] schema no data yet/m);
    expect(r.stdout).toMatch(/^\[info\] backup no backup made with `pap backup`/m);
    expect(r.stdout).toMatch(/^\[skip\] update_available /m);
    expect(snapshot(papHome)).toEqual(before);
  });

  it("a damaged database fails with pap restore and the home is left as it was", () => {
    const before = snapshot(papHome);
    const r = pap("--only", "schema");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fix: pap restore <backup>");
    expect(snapshot(papHome)).toEqual(before);
  });

  it("an interrupted update fails with pap update recover", () => {
    writeFileSync(join(papHome, "update", "pending.json"), "{}", { mode: 0o600 });
    const r = pap("--only", "update_pending");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fix: pap update recover");
  });

  it("exit codes: 1 for a failure, 2 for warnings only, 64 for an unknown id", () => {
    fake.set("fail-show-environment", "");
    const failing = pap("--only", "user_manager");
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("fix: ");
    expect(failing.stdout).not.toContain("SECRET-STDERR");
    fake.set("linger", "no\n");
    expect(pap("--only", "linger").status).toBe(2);
    const bad = pap("--only", "nope");
    expect(bad.status).toBe(64);
    expect(bad.stderr).toContain("node, toolchain, user_manager");
  });

  it("the unit's home is the one inspected, the shell's PAP_HOME is only an info", () => {
    const unitHome = join(scratch, "unit-home");
    mkdirSync(unitHome, { mode: 0o700 });
    fake.set(
      "cat-unit",
      `[Service]\nEnvironment=PAP_HOME=${unitHome}\nExecStart=${process.execPath} /opt/pap/main.js serve --port 7791\n`,
    );
    const before = snapshot(unitHome);
    const r = pap("--only", "home");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`home: ${unitHome} (from the unit)`);
    expect(r.stdout).toContain("[info] home");
    expect(r.stdout).toContain("pap commands follow the unit's home");
    expect(snapshot(unitHome)).toEqual(before);
  });

  it("a whole run asks the fakes only read questions and leaves the home unchanged", () => {
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    const before = [snapshot(papHome), snapshot(home)];
    pap();
    pap("--json");
    expect([snapshot(papHome), snapshot(home)]).toEqual(before);
    expect(fake.calls().length).toBeGreaterThan(0);
    for (const call of fake.calls()) expect(call).toMatch(ALLOWED_CALL);
  });

  it("a healthy default install without build tools still exits 0 (toolchain is info)", () => {
    const empty = join(scratch, "empty-path");
    mkdirSync(empty);
    env.PATH = empty;
    const r = pap("--only", "toolchain,node,home");
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^\[info\] toolchain missing: gcc, g\+\+, make, python3/m);
    expect(r.status).toBe(0);
  });

  it("a home that does not exist is not created", () => {
    env.PAP_HOME = join(scratch, "never-made");
    const r = pap("--only", "home,disk");
    expect(r.status).toBe(0);
    expect(() => statSync(join(scratch, "never-made"))).toThrow();
  });
});
