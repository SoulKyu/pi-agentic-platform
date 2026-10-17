import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  current,
  goodMembers,
  installBed,
  makeRoot,
  readIfExists,
  releases,
  type Root,
} from "./archive-install-bed.ts";

/** A fake node that logs every call; `update apply` can switch `current` the way the real command does. */
const UPDATE_NODE = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$HOME/calls"',
  'printf \'%s\\n\' "${PAP_UNIT-unset}" >> "$HOME/units"',
  'case "$*" in',
  '  *"update apply --help") exit "${HELP_EXIT:-0}" ;;',
  '  *"update apply --release="*)',
  '    if [ -n "$APPLY_SWITCH" ]; then',
  '      ln -sfn "releases/$APPLY_SWITCH" "$HOME/.local/share/pap/current.x" && mv -T "$HOME/.local/share/pap/current.x" "$HOME/.local/share/pap/current"',
  "    fi",
  '    exit "${APPLY_EXIT:-0}" ;;',
  '  *" service install "*)',
  '    if [ -n "$CLOBBER_UNIT" ]; then printf CLOBBERED > "$HOME/.config/systemd/user/pap.service"; fi',
  '    if [ -n "$KILL_SELF" ]; then kill -TERM $PPID; fi ;;',
  "esac",
  'exit "${NODE_EXIT:-0}"',
  "",
].join("\n");

const bedFor = (id: string, root: Root) => {
  const members = goodMembers(id).map((m) =>
    m.name.endsWith("/node/bin/node") ? { ...m, data: UPDATE_NODE } : m,
  );
  return installBed(id, root, { members });
};
const calls = (root: Root) => readIfExists(join(root.home, "calls")).split("\n").filter(Boolean);
const installedR1 = () => installedR1Bed().root;
const installedR1Bed = () => {
  const root = makeRoot();
  const bed = bedFor("r1", root);
  expect(bed.run().status).toBe(0);
  return { root, bed };
};
const applyCalls = (root: Root) => calls(root).filter((line) => line.includes(" update apply "));
const serviceInstalls = (root: Root) => calls(root).filter((line) => line.includes(" service install "));

describe("archive installer: the update path", () => {
  it("hands over to the new release's update apply, never service install, and leaves current to it", () => {
    const root = installedR1();
    const r2 = bedFor("r2", root);
    const result = r2.run();
    expect(result.status).toBe(0);
    const newMain = join(r2.app, "releases/r2/app/apps/daemon/dist/main.js");
    expect(applyCalls(root)).toEqual([
      `--disable-warning=ExperimentalWarning ${newMain} update apply --help`,
      `--disable-warning=ExperimentalWarning ${newMain} update apply --release=r2`,
    ]);
    expect(serviceInstalls(root)).toHaveLength(1); // r1's first install only
    expect(current(r2.app)).toBe("releases/r1"); // the script never switched it: the fake apply did not either
  });

  it("does not hand PAP_UNIT of the caller to update apply (it would update another unit)", () => {
    const root = installedR1();
    const r2 = bedFor("r2", root);
    expect(r2.run({ env: { PAP_UNIT: "pap-preview.service" } }).status).toBe(0);
    const units = readIfExists(join(root.home, "units")).split("\n").filter(Boolean);
    expect(units.length).toBeGreaterThan(0);
    expect(new Set(units)).toEqual(new Set(["unset"]));
  });

  it("current is whatever update apply set", () => {
    const root = installedR1();
    const r2 = bedFor("r2", root);
    expect(r2.run({ env: { APPLY_SWITCH: "r2" } }).status).toBe(0);
    expect(current(r2.app)).toBe("releases/r2");
  });

  it("keeps only the new and the previous release after a success", () => {
    const root = installedR1();
    expect(bedFor("r2", root).run({ env: { APPLY_SWITCH: "r2" } }).status).toBe(0);
    const r3 = bedFor("r3", root);
    expect(r3.run({ env: { APPLY_SWITCH: "r3" } }).status).toBe(0);
    expect(releases(r3.app)).toEqual(["r2", "r3"]);
  });

  it("runs the M6 reinstall path when flags are given", () => {
    const root = installedR1();
    const r2 = bedFor("r2", root);
    expect(r2.run({ args: ["--port", "7790"] }).status).toBe(0);
    expect(current(r2.app)).toBe("releases/r2");
    expect(applyCalls(root)).toEqual([]);
    expect(serviceInstalls(root)).toHaveLength(2);
    expect(serviceInstalls(root)[1]).toMatch(/--port 7790$/);
  });

  it("runs the M6 path for a first install, flags or not", () => {
    const root = makeRoot();
    const r1 = bedFor("r1", root);
    expect(r1.run().status).toBe(0);
    expect(current(r1.app)).toBe("releases/r1");
    expect(applyCalls(root)).toEqual([]);
    expect(serviceInstalls(root)).toHaveLength(1);
  });

  it("re-installing the current release uses the M6 path", () => {
    const root = makeRoot();
    const r1 = bedFor("r1", root);
    expect(r1.run().status).toBe(0);
    expect(r1.run().status).toBe(0);
    expect(applyCalls(root)).toEqual([]);
    expect(serviceInstalls(root)).toHaveLength(2);
  });

  describe("the outcome of update apply", () => {
    const failing = (code: string) => {
      const root = installedR1();
      const r2 = bedFor("r2", root);
      // the fake apply moves current, as the real one does before it fails: the script must not touch it afterwards
      const result = r2.run({ env: { APPLY_SWITCH: "r2", APPLY_EXIT: code } });
      return { root, r2, result };
    };

    it("exit 4 is exit 4 with one sentence; the trap leaves current alone and nothing is pruned", () => {
      const { root, r2, result } = failing("4");
      expect(result.status).toBe(4);
      expect(result.stderr).toContain(
        "the update failed; the previous release (r1) was restored and is running",
      );
      expect(current(r2.app)).toBe("releases/r2");
      expect(readIfExists(root.sysLog)).not.toContain("restart");
      expect(releases(r2.app)).toEqual(["r1", "r2"]);
    });

    it("exit 5 is exit 5 and names pap update recover", () => {
      const { r2, result } = failing("5");
      expect(result.status).toBe(5);
      expect(result.stderr).toContain("the rollback is INCOMPLETE: run: pap update recover");
      expect(current(r2.app)).toBe("releases/r2");
    });

    it("exit 3 is installed but not verified", () => {
      const { r2, result } = failing("3");
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("installed but NOT verified");
      expect(current(r2.app)).toBe("releases/r2");
    });

    it("any other code dies with exit 1 naming the code", () => {
      const { result } = failing("2");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pap update apply failed (exit code 2)");
      expect(result.stderr).toContain("if it was interrupted, run: pap doctor");
    });
  });

  describe("a release with no update apply (M6b-RT-19)", () => {
    it("is refused with no flags before current is touched", () => {
      const root = installedR1();
      const r2 = bedFor("r2", root);
      const result = r2.run({ env: { HELP_EXIT: "1" } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("has no 'pap update apply'");
      expect(result.stderr).toContain("explicit flags");
      expect(current(r2.app)).toBe("releases/r1");
      expect(serviceInstalls(root)).toHaveLength(1);
      expect(applyCalls(root).filter((line) => line.includes("--release"))).toEqual([]);
    });

    it("installs through the M6 path when flags are given", () => {
      const root = installedR1();
      const r2 = bedFor("r2", root);
      expect(r2.run({ args: ["--port", "7790"], env: { HELP_EXIT: "1" } }).status).toBe(0);
      expect(current(r2.app)).toBe("releases/r2");
      expect(serviceInstalls(root)).toHaveLength(2);
    });
  });

  describe("update/op.lock (M6bR51)", () => {
    const lockFile = (root: Root) => {
      mkdirSync(join(root.home, ".pap/update"), { recursive: true });
      return join(root.home, ".pap/update/op.lock");
    };
    const startOf = (pid: number) => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    };

    it("a reinstall with flags is refused while a live update, rollback or restore holds it", () => {
      const root = installedR1();
      writeFileSync(lockFile(root), `${process.pid} ${startOf(process.pid)}\n`);
      const r2 = bedFor("r2", root);
      const result = r2.run({ args: ["--port", "7790"] });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `another pap update, rollback, recover or restore is running (pid ${process.pid})`,
      );
      expect(current(r2.app)).toBe("releases/r1");
      expect(serviceInstalls(root)).toHaveLength(1);
    });

    it("honours --home for the lock folder", () => {
      const root = installedR1();
      const other = join(root.root, "other-home");
      mkdirSync(join(other, "update"), { recursive: true });
      writeFileSync(join(other, "update/op.lock"), `${process.pid} ${startOf(process.pid)}\n`);
      const r2 = bedFor("r2", root);
      expect(r2.run({ args: ["--home", other] }).status).toBe(1);
      expect(current(r2.app)).toBe("releases/r1");
    });

    const live = () => `${process.pid} ${startOf(process.pid)}\n`;
    const writeAt = (home: string, text: string) => {
      mkdirSync(join(home, "update"), { recursive: true });
      writeFileSync(join(home, "update/op.lock"), text);
    };

    it("honours --home=<dir>", () => {
      const root = installedR1();
      const other = join(root.root, "other-home");
      writeAt(other, live());
      const r2 = bedFor("r2", root);
      expect(r2.run({ args: [`--home=${other}`] }).status).toBe(1);
      expect(current(r2.app)).toBe("releases/r1");
    });

    it("E3a: refuses on a live lock in the home named by the installed unit", () => {
      const root = installedR1();
      const unitHome = join(root.root, "unit-home");
      writeAt(unitHome, live());
      const r2 = bedFor("r2", root);
      const unit = `[Service]\nEnvironment=NODE_ENV=production PAP_HOME=${unitHome}\nExecStart=/x`;
      const result = r2.run({ args: ["--port", "7790"], env: { UNIT_TEXT: unit } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is running");
      expect(current(r2.app)).toBe("releases/r1");
    });

    it("E3b: a later Environment= reset in a drop-in forgets the earlier home", () => {
      const root = installedR1();
      const unitHome = join(root.root, "unit-home");
      writeAt(unitHome, live());
      const r2 = bedFor("r2", root);
      const unit = `[Service]\nEnvironment=PAP_HOME=${unitHome}\n[Service]\nEnvironment=\n`;
      expect(r2.run({ args: ["--port", "7790"], env: { UNIT_TEXT: unit } }).status).toBe(0);
    });

    it("E4: refuses on a live lock in ~/.pap when the unit names no home, whatever the shell's PAP_HOME", () => {
      const root = installedR1();
      writeAt(join(root.home, ".pap"), live());
      const r2 = bedFor("r2", root);
      const unit = "[Service]\nExecStart=/x";
      const result = r2.run({
        args: ["--port", "7790"],
        env: { UNIT_TEXT: unit, PAP_HOME: join(root.root, "elsewhere") },
      });
      expect(result.status).toBe(1);
      expect(current(r2.app)).toBe("releases/r1");
    });

    it("a dead pid does not block", () => {
      const root = installedR1();
      writeAt(join(root.home, ".pap"), "2147483646 123\n");
      const r2 = bedFor("r2", root);
      expect(r2.run({ args: ["--port", "7790"] }).status).toBe(0);
    });

    it("a stale lock (dead process, or a recycled pid) does not block", () => {
      const root = installedR1();
      writeFileSync(lockFile(root), `${process.pid} 1\n`);
      const r2 = bedFor("r2", root);
      expect(r2.run({ args: ["--port", "7790"] }).status).toBe(0);
      expect(current(r2.app)).toBe("releases/r2");
    });

    it("the update path leaves the lock to update apply: a live holder makes apply refuse, not the script", () => {
      const root = installedR1();
      writeFileSync(lockFile(root), `${process.pid} ${startOf(process.pid)}\n`);
      const r2 = bedFor("r2", root);
      expect(r2.run().status).toBe(0); // the fake apply does not look at the lock; the script holds none of its own
      expect(applyCalls(root)).toHaveLength(2);
    });
  });

  describe("a unit is never rewritten by accident (M6b-C13)", () => {
    const UNIT = "[Service]\nExecStart=/x serve --port 7791 --home /h\n";
    const unitPath = (root: Root) => join(root.home, ".config/systemd/user/pap.service");
    const withUnit = (root: Root) => {
      mkdirSync(join(root.home, ".config/systemd/user"), { recursive: true });
      writeFileSync(unitPath(root), UNIT);
      chmodSync(unitPath(root), 0o640);
    };
    const sysLines = (root: Root) => readIfExists(root.sysLog).split("\n").filter(Boolean);

    it("a flagless rerun of the installed release restarts the unit and never calls service install", () => {
      const { root, bed } = installedR1Bed();
      withUnit(root);
      const before = sysLines(root).length;
      const result = bed.run({ env: { CLOBBER_UNIT: "1" } });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain("already installed; restarted");
      expect(readFileSync(unitPath(root), "utf8")).toBe(UNIT);
      expect(serviceInstalls(root)).toHaveLength(1);
      expect(sysLines(root).slice(before)).toContain("--user restart pap.service");
      expect(current(join(root.home, ".local/share/pap"))).toBe("releases/r1");
    });

    it("the same rerun with flags keeps the M6 path", () => {
      const { root, bed } = installedR1Bed();
      withUnit(root);
      expect(bed.run({ args: ["--port", "7790"] }).status).toBe(0);
      expect(serviceInstalls(root)).toHaveLength(2);
    });

    it("a failing service install restores the previous unit file byte-identical before it restarts", () => {
      const root = installedR1();
      withUnit(root);
      const before = sysLines(root).length;
      const r2 = bedFor("r2", root);
      const result = r2.run({ args: ["--port", "7790"], env: { NODE_EXIT: "1", CLOBBER_UNIT: "1" } });
      expect(result.status).toBe(1);
      expect(readFileSync(unitPath(root), "utf8")).toBe(UNIT);
      expect(statSync(unitPath(root)).mode & 0o777).toBe(0o640);
      expect(current(r2.app)).toBe("releases/r1");
      const log = sysLines(root).slice(before);
      const reload = log.indexOf("--user daemon-reload");
      expect(reload).toBeGreaterThan(-1);
      expect(log.indexOf("--user restart pap.service")).toBeGreaterThan(reload);
    });

    it("a TERM during service install still restores the unit, current and the service", () => {
      const root = installedR1();
      withUnit(root);
      const before = sysLines(root).length;
      const r2 = bedFor("r2", root);
      const result = r2.run({ args: ["--port", "7790"], env: { CLOBBER_UNIT: "1", KILL_SELF: "1" } });
      expect(result.status).toBe(143);
      expect(readFileSync(unitPath(root), "utf8")).toBe(UNIT);
      expect(statSync(unitPath(root)).mode & 0o777).toBe(0o640);
      expect(current(r2.app)).toBe("releases/r1");
      const log = sysLines(root).slice(before);
      const reload = log.indexOf("--user daemon-reload");
      expect(reload).toBeGreaterThan(-1);
      expect(log.indexOf("--user restart pap.service")).toBeGreaterThan(reload);
    });

    it("a flagless same-release rerun is refused before any restart while the unit's home has a live lock", () => {
      const { root, bed } = installedR1Bed();
      withUnit(root);
      const unitHome = join(root.root, "unit-home");
      mkdirSync(join(unitHome, "update"), { recursive: true });
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      writeFileSync(join(unitHome, "update/op.lock"), `${process.pid} ${started}\n`);
      const before = sysLines(root).length;
      const result = bed.run({ env: { UNIT_TEXT: `[Service]\nEnvironment=PAP_HOME=${unitHome}\n` } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is running");
      expect(
        sysLines(root)
          .slice(before)
          .filter((l) => l.includes("restart")),
      ).toEqual([]);
    });

    it("a failed first install leaves no unit of its own to restore", () => {
      const root = makeRoot();
      const bed = bedFor("r1", root);
      expect(bed.run({ env: { NODE_EXIT: "1" } }).status).toBe(1);
      expect(sysLines(root)).not.toContain("--user daemon-reload");
    });
  });
});
