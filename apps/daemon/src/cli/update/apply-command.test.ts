import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { harness, URL_READY, type Ctl, type Harness } from "../testing/apply-harness.ts";
import { cliIo } from "../testing/cli-io.ts";
import { acquireOpLock } from "../ops/op-lock.ts";
import type { ApplyDeps, ApplyOutcome } from "./apply.ts";
import { ApplyRefused } from "./apply.ts";
import { makeApplyCommand, type ApplySeams } from "./apply-command.ts";
import type { Target } from "../ops/target.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const NEVER = { kind: "never" } as const;
const OUTSIDE = "0::/user.slice/user-1000.slice/session-3.scope\n";
const NOW = Date.parse("2026-10-17T10:00:00.000Z");

const unitText = (env: Harness, exec = "") =>
  `[Service]\nExecStart=/opt/node --disable-warning=ExperimentalWarning /opt/main.js serve${exec}\nEnvironment=PAP_HOME=${env.home}\n`;

interface Seen {
  target?: Target;
  options?: Parameters<ApplySeams["makeDeps"]>[2];
  units: string[];
}

function command(env: Harness, overrides: Partial<ApplySeams> = {}, text: string | null = unitText(env)) {
  const seen: Seen = { units: [] };
  const seams: ApplySeams = {
    makeDeps: async (_io, target, options) => {
      seen.target = target;
      seen.options = options;
      return env.deps;
    },
    apply: async () => ({ kind: "updated", snapshot: null }),
    unitText: async (_io, unit) => {
      seen.units.push(unit);
      return text;
    },
    readCgroup: () => OUTSIDE,
    ancestors: () => [],
    ...overrides,
  };
  return { cmd: makeApplyCommand(seams), seen };
}

async function run(
  cmd: ReturnType<typeof makeApplyCommand>,
  args: string[],
  ioOptions: Parameters<typeof cliIo>[0] = { now: NOW },
) {
  const { io, stdout, stderr } = cliIo(ioOptions);
  const { values, positionals } = parseArgs({
    args,
    options: cmd.options,
    strict: true,
    allowPositionals: true,
  });
  let code: number;
  try {
    code = await cmd.run({ values, positionals, io });
  } catch (error) {
    const err = error as { name: string; exitCode?: number; message: string };
    code = err.exitCode ?? -1;
    io.stderr.write(`${err.name}: ${err.message}\n`);
  }
  return { code, out: stdout(), err: stderr() };
}

const base = (env: Harness) => ["--release", "new", "--app-root", env.app];
const stubOutcome = (outcome: ApplyOutcome): Partial<ApplySeams> => ({ apply: async () => outcome });

describe("usage and refusals", () => {
  it("--help prints one line, exits 0 and touches nothing", async () => {
    h = harness();
    const { cmd, seen } = command(h);
    const result = await run(cmd, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.trimEnd().split("\n")).toHaveLength(1);
    expect(result.out).toContain("pap update apply --release <id>");
    expect(seen.units).toEqual([]);
    expect(seen.target).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(existsSync(join(h.home, "update"))).toBe(false);
  });

  it.each([
    [[], "--release"],
    [["--release", "../x"], "release"],
    [["--release", ".."], "release"],
    [["--release", "new", "--deadline-s", "5"], "--deadline-s"],
    [["--release", "new", "--deadline-s", "601"], "--deadline-s"],
    [["--release", "new", "--deadline-s", "abc"], "--deadline-s"],
    [["--release", "new", "--settle-s", "61"], "--settle-s"],
    [["--release", "new", "--settle-s=-1"], "--settle-s"],
    [["--release", "new", "extra"], "no argument"],
  ])("%j is a usage error naming %s", async (args, word) => {
    h = harness();
    const { cmd } = command(h);
    const result = await run(cmd, args);
    expect(result.code).toBe(-1);
    expect(result.err).toContain("UsageError");
    expect(result.err).toContain(word);
    expect(h.calls).toEqual([]);
  });

  it("accepts the edges: --deadline-s 30 and 600, --settle-s 0 and 60", async () => {
    h = harness();
    const { cmd, seen } = command(h);
    expect((await run(cmd, [...base(h), "--deadline-s", "30", "--settle-s", "0"])).code).toBe(0);
    expect(seen.options).toMatchObject({ deadlineMs: 30_000, settleMs: 0 });
    expect((await run(cmd, [...base(h), "--deadline-s", "600", "--settle-s", "60"])).code).toBe(0);
    expect(seen.options).toMatchObject({ deadlineMs: 600_000, settleMs: 60_000 });
  });

  it("an --app-root that is not a safe absolute path is refused", async () => {
    h = harness();
    const { cmd } = command(h);
    const result = await run(cmd, ["--release", "new", "--app-root", "relative/path"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--app-root");
  });

  it("no unit installed: tells to run the installer with flags", async () => {
    h = harness();
    const { cmd } = command(h, {}, null);
    const result = await run(cmd, base(h));
    expect(result.code).toBe(1);
    expect(result.err).toContain("run the installer with flags");
    expect(h.calls).toEqual([]);
  });

  it("a unit pap cannot read is refused with a fixed sentence", async () => {
    h = harness();
    const { cmd } = command(h, {}, "[Service]\nExecStart=/bin/true\n");
    const result = await run(cmd, base(h));
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot be read");
    expect(h.calls).toEqual([]);
  });

  it("an ApplyRefused from the preflight is exit 1 with its sentence", async () => {
    h = harness();
    const { cmd } = command(h, {
      apply: async () => {
        throw new ApplyRefused("release new is incomplete: nothing was changed");
      },
    });
    const result = await run(cmd, base(h));
    expect(result.code).toBe(1);
    expect(result.err).toContain("release new is incomplete: nothing was changed");
  });
});

describe("the unit decides, not the environment (M6bR42, M6bR50)", () => {
  it("home, host, port and tls come from the unit text; PAP_HOME and PAP_PORT in the environment are ignored", async () => {
    h = harness();
    const exec = " --host 192.0.2.1 --port 8080 --tls-cert /x/c.pem --tls-key /x/k.pem";
    const { cmd, seen } = command(h, {}, unitText(h, exec));
    const result = await run(cmd, base(h), { now: NOW, env: { PAP_HOME: "/elsewhere", PAP_PORT: "9999" } });
    expect(result.code).toBe(0);
    expect(seen.target?.home).toBe(h.home);
    expect(seen.target?.homeSource).toBe("unit");
    expect(seen.target?.parsed).toMatchObject({ host: "192.0.2.1", port: 8080, tls: true });
    expect(seen.options).toMatchObject({ app: h.app, deadlineMs: 120_000, settleMs: 10_000 });
  });

  it("a unit without PAP_HOME works on ~/.pap of the user, not on the environment's PAP_HOME", async () => {
    h = harness();
    const text = "[Service]\nExecStart=/opt/node /opt/main.js serve\n";
    const { cmd, seen } = command(h, {}, text);
    await run(cmd, base(h), { now: NOW, env: { PAP_HOME: "/elsewhere" }, homedir: join(h.root, "someone") });
    expect(seen.target?.home).toBe(join(h.root, "someone", ".pap"));
    expect(seen.target?.homeSource).toBe("default");
  });

  it("--unit reads that unit; the flag wins over PAP_UNIT; the default is pap.service", async () => {
    h = harness();
    const { cmd, seen } = command(h);
    await run(cmd, [...base(h), "--unit", "pap-preview.service"], {
      now: NOW,
      env: { PAP_UNIT: "other.service" },
    });
    await run(cmd, base(h), { now: NOW, env: { PAP_UNIT: "other.service" } });
    await run(cmd, base(h));
    expect(seen.units).toEqual(["pap-preview.service", "other.service", "pap.service"]);
  });

  it("a bad --unit is a usage error", async () => {
    h = harness();
    const { cmd } = command(h);
    expect((await run(cmd, [...base(h), "--unit", "../x"])).code).toBe(64);
  });
});

describe("the guard (M6bR52, M6b-RT-03)", () => {
  const SENTENCE = "run this from an SSH or console shell: stopping pap would end this terminal";

  it("a cgroup that names the unit refuses before anything is touched", async () => {
    h = harness();
    const { cmd } = command(h, {
      readCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pap.service\n",
    });
    const result = await run(cmd, base(h));
    expect(result.code).toBe(1);
    expect(result.err).toContain(SENTENCE);
    expect(h.calls).toEqual([]);
    expect(existsSync(join(h.home, "update", "pending.json"))).toBe(false);
  });

  it("an ancestor that is the pid in pap.lock refuses the same way", async () => {
    h = harness();
    writeFileSync(join(h.home, "pap.lock"), "4242 99\n");
    const { cmd } = command(h, { ancestors: () => [50, 4242, 1] });
    const result = await run(cmd, base(h));
    expect(result.code).toBe(1);
    expect(result.err).toContain(SENTENCE);
    expect(h.calls).toEqual([]);
    expect(existsSync(join(h.home, "update", "pending.json"))).toBe(false);
  });

  it("the preview unit is not refused by a cgroup that names pap.service", async () => {
    h = harness();
    const { cmd } = command(h, { readCgroup: () => "0::/app.slice/pap.service\n" });
    expect((await run(cmd, [...base(h), "--unit", "pap-preview.service"])).code).toBe(0);
  });
});

describe("the operation lock (M6bR51)", () => {
  it("a busy update/op.lock exits 1 with its message and no systemd call", async () => {
    h = harness();
    const release = acquireOpLock(h.home);
    try {
      const { cmd } = command(h);
      const result = await run(cmd, base(h));
      expect(result.code).toBe(1);
      expect(result.err).toContain("another pap update, rollback, recover or restore is running");
      expect(h.calls).toEqual([]);
    } finally {
      release();
    }
  });

  it("is held for the whole apply and released after it, also when apply throws", async () => {
    h = harness();
    const lock = join(h.home, "update", "op.lock");
    const during: boolean[] = [];
    const { cmd } = command(h, {
      apply: async () => {
        during.push(existsSync(lock));
        throw new ApplyRefused("nope");
      },
    });
    expect((await run(cmd, base(h))).code).toBe(1);
    expect(during).toEqual([true]);
    expect(existsSync(lock)).toBe(false);
  });

  it("passes the dependencies of the wiring to apply", async () => {
    h = harness();
    let received: ApplyDeps | undefined;
    const { cmd } = command(h, {
      apply: async (deps, to) => {
        received = deps;
        expect(to).toBe("new");
        return { kind: "updated", snapshot: null };
      },
    });
    await run(cmd, base(h));
    expect(received).toBe(h.deps);
  });
});

describe("outcomes", () => {
  it("updated: exit 0 with the three lines (M6bR11a)", async () => {
    h = harness();
    const { applyRelease } = await import("./apply.ts");
    const { cmd } = command(h, { apply: applyRelease });
    const result = await run(cmd, base(h));
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("updated: old -> new\n");
    expect(result.out).toMatch(
      /database snapshot: backups\/pre-update-new-[0-9A-Za-z-]+\.db \(kept; the three newest are kept\)\n/,
    );
    expect(result.out).toContain("any running turn was interrupted\n");
  });

  it("updated without a database has no snapshot line", async () => {
    h = harness({ withDb: false });
    const { applyRelease } = await import("./apply.ts");
    const { cmd } = command(h, { apply: applyRelease });
    const result = await run(cmd, base(h));
    expect(result.code, result.err).toBe(0);
    expect(result.out).not.toContain("database snapshot");
  });

  it("unverified: exit 3, the release is installed, the way to check", async () => {
    h = harness();
    const { cmd } = command(h, stubOutcome({ kind: "unverified", snapshot: null }));
    const result = await run(cmd, base(h));
    expect(result.code).toBe(3);
    expect(result.out).toContain("updated: old -> new");
    expect(result.err).toContain("systemctl --user status pap.service");
  });

  it("rolled back, database untouched: exit 4 with the reason and the previous release", async () => {
    h = harness();
    const { cmd } = command(
      h,
      stubOutcome({ kind: "rolled_back", reason: "the health probe failed", restoredDatabase: false }),
    );
    const result = await run(cmd, base(h));
    expect(result.code).toBe(4);
    expect(result.err).toContain("update failed: the health probe failed");
    expect(result.err).toContain("the previous release (old) is back and running");
    expect(result.err).not.toContain("discarded");
    expect(result.out).not.toContain("updated:");
  });

  it("rolled back with the database restored: says what was discarded and since when", async () => {
    h = harness();
    const keptDatabase = `${h.home}/backups/pre-rollback-2026-10-17T10-00-00-000Z.db`;
    const { cmd } = command(
      h,
      stubOutcome({ kind: "rolled_back", reason: "x", restoredDatabase: true, keptDatabase }),
    );
    const result = await run(cmd, base(h));
    expect(result.code).toBe(4);
    expect(result.err).toContain(`kept as ${keptDatabase} (to get`);
    expect(result.err).toContain(
      "writes made since 2026-10-17T10:00:00.000Z were discarded: the restored database is the one the old release left",
    );
  });

  it("rolled back with nothing kept: says so and names no file", async () => {
    h = harness();
    const { cmd } = command(h, stubOutcome({ kind: "rolled_back", reason: "x", restoredDatabase: true }));
    const result = await run(cmd, base(h));
    expect(result.err).toContain("no copy of the replaced database was kept");
    expect(result.err).not.toContain("pre-rollback");
  });

  it("rollback failed: exit 5 with the exact manual commands", async () => {
    h = harness();
    const { cmd } = command(h, stubOutcome({ kind: "rollback_failed", reason: "r", step: "restart" }));
    const result = await run(cmd, base(h));
    expect(result.code).toBe(5);
    expect(result.err).toContain("pap update recover");
    expect(result.err).toContain("systemctl --user status pap.service");
    expect(result.err).not.toContain("is back and running");
  });

  it("rollback failed on another unit names that unit in both commands", async () => {
    h = harness();
    const { cmd } = command(h, stubOutcome({ kind: "rollback_failed", reason: "r", step: "stop" }));
    const result = await run(cmd, [...base(h), "--unit", "pap-preview.service"]);
    expect(result.code).toBe(5);
    expect(result.err).toContain("pap update recover --unit pap-preview.service");
    expect(result.err).toContain("systemctl --user status pap-preview.service");
  });

  it("rollback failed at the database step prints its code and the way out (N3)", async () => {
    h = harness();
    const code = "the journal names no snapshot: the database cannot be restored automatically";
    const { cmd } = command(h, stubOutcome({ kind: "rollback_failed", reason: "r", step: "database", code }));
    const result = await run(cmd, base(h));
    expect(result.code).toBe(5);
    expect(result.err).toContain(code);
    expect(result.err).toContain("pap restore");
    expect(result.err).toContain(`${h.home}/backups/`);
  });
});

describe("end to end over the real core (fake systemd calls)", () => {
  const go = async (ctl: Partial<Ctl>) => {
    h = harness({ ctl });
    const { applyRelease } = await import("./apply.ts");
    const { cmd } = command(h, { apply: applyRelease });
    return run(cmd, base(h));
  };

  it("a migration that ran and a release that never listens: exit 4 with the restore sentence", async () => {
    const result = await go({ migrate: true, listening: [NEVER, URL_READY] });
    expect(result.code).toBe(4);
    expect(result.err).toContain("were discarded");
    expect(h?.ids()).toEqual(["001"]);
  });

  it("an old release that does not come back: exit 5", async () => {
    const result = await go({ listening: [NEVER] });
    expect(result.code).toBe(5);
  });

  it("an unreadable journal with a healthy daemon: exit 3", async () => {
    const result = await go({ listening: [{ kind: "unreadable" }] });
    expect(result.code).toBe(3);
  });
});
