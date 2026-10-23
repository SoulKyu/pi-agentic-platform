import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE,
  current,
  hasCurrent,
  installBed,
  makeRoot,
  readIfExists,
  releases,
} from "./archive-install-bed.ts";

describe("archive installer", () => {
  it("installs, points current at the release and runs service install", () => {
    const bed = installBed("r1");
    const result = bed.run();
    expect(result.status).toBe(0);
    expect(current(bed.app)).toBe("releases/r1");
    const node = join(bed.app, "current/node/bin/node");
    const main = join(bed.app, "current/app/apps/daemon/dist/main.js");
    expect(readFileSync(join(bed.home, "calls"), "utf8")).toBe(
      `--disable-warning=ExperimentalWarning ${main} service install --node ${node} --main ${main}\n`,
    );
    expect(releases(bed.app)).toEqual(["r1"]);
    expect(statSync(bed.app).mode & 0o777).toBe(0o700);
  });

  it("forwards its flags to service install", () => {
    const bed = installBed("r1");
    expect(bed.run({ args: ["--port", "7790", "--home", "/x/y"] }).status).toBe(0);
    expect(readFileSync(join(bed.home, "calls"), "utf8")).toMatch(/--main \S+ --port 7790 --home \/x\/y\n$/);
  });

  it("refuses an archive that differs by one byte and installs nothing", () => {
    const bed = installBed("r1");
    appendFileSync(bed.archive, "x");
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch: nothing was installed");
    expect(existsSync(join(bed.home, ".local/share/pap/current"))).toBe(false);
    expect(existsSync(join(bed.home, ".local/share/pap/releases/r1"))).toBe(false);
    expect(readdirSync(join(bed.home, ".local/share/pap/releases"))).toEqual([]);
    expect(readIfExists(join(bed.home, "calls"))).toBe("");
  });

  it("moves current to the new release, keeps the previous one and prunes older ones, leaving ~/.pap alone", () => {
    const root = makeRoot();
    mkdirSync(join(root.home, ".pap"));
    writeFileSync(join(root.home, ".pap/sentinel"), "keep");
    const sentinel = () => [
      readdirSync(join(root.home, ".pap")),
      readFileSync(join(root.home, ".pap/sentinel"), "utf8"),
    ];
    const r1 = installBed("r1", root);
    expect(r1.run().status).toBe(0);
    expect(sentinel()).toEqual([["sentinel"], "keep"]);
    const r2 = installBed("r2", root);
    expect(r2.run({ args: ["--port", "7790"] }).status).toBe(0);
    expect(current(r2.app)).toBe("releases/r2");
    expect(releases(r2.app)).toEqual(["r1", "r2"]);
    expect(sentinel()).toEqual([["sentinel"], "keep"]);
    const r3 = installBed("r3", root);
    expect(r3.run({ args: ["--port", "7790"] }).status).toBe(0);
    expect(current(r3.app)).toBe("releases/r3");
    expect(releases(r3.app)).toEqual(["r2", "r3"]);
    expect(sentinel()).toEqual([["sentinel"], "keep"]);
  });

  describe("a failed install leaves the working one in place", () => {
    it("tampered second archive", () => {
      const root = makeRoot();
      const r1 = installBed("r1", root);
      expect(r1.run().status).toBe(0);
      const r2 = installBed("r2", root);
      appendFileSync(r2.archive, "x");
      expect(r2.run().status).toBe(1);
      expect(current(r1.app)).toBe("releases/r1");
      expect(existsSync(join(r1.app, "releases/r1/node/bin/node"))).toBe(true);
      expect(releases(r1.app)).toEqual(["r1"]);
    });

    it("service install failing puts the previous release back and restarts it", () => {
      const root = makeRoot();
      const r1 = installBed("r1", root);
      expect(r1.run().status).toBe(0);
      const r2 = installBed("r2", root);
      const result = r2.run({ args: ["--port", "7790"], env: { NODE_EXIT: "1" } });
      expect(result.status).toBe(1);
      expect(current(r2.app)).toBe("releases/r1");
      expect(readFileSync(root.sysLog, "utf8")).toContain("--user restart pap.service");
      expect(result.stderr).toContain("the previous release (r1) is back in place");
      expect(releases(r2.app)).toEqual(["r1", "r2"]);
    });

    it("a first install that fails leaves no current", () => {
      const bed = installBed("r1");
      expect(bed.run({ env: { NODE_EXIT: "1" } }).status).toBe(1);
      expect(hasCurrent(bed.app)).toBe(false);
    });

    it("a failing third install prunes nothing", () => {
      const root = makeRoot();
      expect(installBed("r1", root).run().status).toBe(0);
      expect(installBed("r2", root).run({ args: ["--port", "7790"] }).status).toBe(0);
      const r3 = installBed("r3", root);
      expect(r3.run({ args: ["--port", "7790"], env: { NODE_EXIT: "1" } }).status).toBe(1);
      expect(current(r3.app)).toBe("releases/r2");
      expect(releases(r3.app)).toEqual(["r1", "r2", "r3"]);
    });
  });

  it("refuses a glibc older than the build host, accepts an older requirement", () => {
    const high = installBed("r1", makeRoot(), { minGlibc: "99.9" });
    const refused = high.run();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("older than 99.9");
    expect(existsSync(join(high.app, "releases"))).toBe(false);
    expect(installBed("r1", makeRoot(), { minGlibc: "2.0" }).run().status).toBe(0);
  });

  it("stops on a missing user manager before computing the checksum", () => {
    const bed = installBed("r1");
    rmSync(bed.archive);
    const result = bed.run({ env: { NO_MANAGER: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no systemd user manager");
  });

  it.each([
    ["relative", "relative/home"],
    ["unset", undefined],
  ])("refuses a %s HOME", (_label, home) => {
    const bed = installBed("r1");
    rmSync(bed.archive);
    const result = bed.run({ env: { HOME: home } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HOME must be an absolute path");
  });

  it("refuses an archive that is a symbolic link", () => {
    const bed = installBed("r1");
    const real = join(bed.dist, "real.tar.gz");
    writeFileSync(real, readFileSync(bed.archive));
    rmSync(bed.archive);
    symlinkSync(real, bed.archive);
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not be a symbolic link");
  });

  it.skipIf(process.getuid?.() !== 0)("refuses to run as root", () => {
    const result = installBed("r1").run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("do not run as root");
  });

  it("holds no eval, curl, wget, stray sudo or command substitution around the archive name", () => {
    const text = readFileSync(TEMPLATE, "utf8");
    expect(text).not.toMatch(/\b(eval|curl|wget)\b/);
    expect(text).not.toMatch(/\bsudo\b/);
    expect(text).not.toMatch(/\$\([^)]*ARCHIVE_NAME/);
  });

  describe("unsafe HOME", () => {
    it.each([
      ["a space", (home: string) => `${home} x`],
      ["a percent sign", (home: string) => `${home}%h`],
      ["a trailing slash", (home: string) => `${home}/`],
      ["a dot-dot segment", (home: string) => `${home}/../home`],
      ["a double slash", (home: string) => `${home}//x`],
      ["a dot segment at the end", (home: string) => `${home}/.`],
      ["a dot segment inside", (home: string) => `${home}/./x`],
    ])("refuses %s before touching anything", (_label, make) => {
      const bed = installBed("r1");
      const unsafe = make(bed.home);
      if (/[ %]/.test(unsafe)) mkdirSync(unsafe);
      const result = bed.run({ home: unsafe });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not safe in a systemd unit");
      expect(readdirSync(bed.home)).toEqual([]);
      if (existsSync(unsafe)) expect(readdirSync(unsafe)).toEqual([]);
      expect(readIfExists(bed.sysLog)).toBe("");
    });
  });

  it("replaces a half-moved release and removes stale stage folders", () => {
    const bed = installBed("r1");
    mkdirSync(join(bed.app, "releases/r1/node"), { recursive: true });
    mkdirSync(join(bed.app, "releases/.stage.OLD123"));
    expect(bed.run().status).toBe(0);
    expect(statSync(join(bed.app, "releases/r1/node/bin/node")).mode & 0o100).toBe(0o100);
    expect(releases(bed.app)).toEqual(["r1"]);
    expect(readdirSync(join(bed.app, "releases"))).not.toContain(".stage.OLD123");
  });

  it("reads only the private copy after copying (no check-then-use on the user-writable file)", () => {
    const text = readFileSync(TEMPLATE, "utf8");
    const at = text.indexOf('cp -- "$source_archive" "$copy"');
    expect(at).toBeGreaterThan(0);
    expect(text.slice(text.indexOf("\n", at))).not.toContain("source_archive");
    expect(text).toContain('copy="$stage/archive.tar.gz"');
  });

  it("reports every failure of service install as exit 1, naming its own code", () => {
    const bed = installBed("r1");
    const result = bed.run({ env: { NODE_EXIT: "64" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pap service install failed (exit code 64)");
  });

  it("says so when the service cannot be restarted on the restored release", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const result = installBed("r2", root).run({
      args: ["--port", "7790"],
      env: { NODE_EXIT: "1", RESTART_FAILS: "1" },
    });
    expect(result.status).toBe(1);
    expect(current(root.home + "/.local/share/pap")).toBe("releases/r1");
    expect(result.stderr).toContain("restarting failed: run systemctl --user restart pap.service");
  });

  it("tightens a looser existing install folder", () => {
    const bed = installBed("r1");
    mkdirSync(join(bed.app, "releases"), { recursive: true, mode: 0o755 });
    chmodSync(bed.app, 0o755);
    chmodSync(join(bed.app, "releases"), 0o755);
    expect(bed.run().status).toBe(0);
    expect(statSync(bed.app).mode & 0o777).toBe(0o700);
    expect(statSync(join(bed.app, "releases")).mode & 0o777).toBe(0o700);
  });

  it("never follows a symbolic link when pruning old releases", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const outside = join(root.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "precious");
    symlinkSync(outside, join(root.home, ".local/share/pap/releases/r0"));
    expect(installBed("r2", root).run().status).toBe(0);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("precious");
  });

  it("ignores TAR_OPTIONS from the environment", () => {
    const bed = installBed("r1");
    expect(bed.run({ env: { TAR_OPTIONS: "--exclude=main.js" } }).status).toBe(0);
  });

  it.each([
    ["prints nothing", { GETCONF_EMPTY: "1" }],
    ["prints a line with no space (musl)", { GETCONF_OUT: "musl" }],
    ["exits non-zero", { GETCONF_FAILS: "1" }],
  ])("dies with a fixed sentence when getconf %s", (_l, env) => {
    const result = installBed("r1").run({ env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read the glibc version: this archive needs glibc");
    expect(result.stderr).not.toContain("getconf: broken");
  });

  it("dies with a fixed sentence when the link list cannot be read", () => {
    const result = installBed("r1").run({ env: { FAIL_FIND_LINKS: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the extracted archive");
  });

  it.skipIf(process.getuid?.() === 0)("removes a stale stage that holds a 0100 folder", () => {
    const bed = installBed("r1");
    const locked = join(bed.app, "releases/.stage.OLD123/locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "f"), "x");
    chmodSync(locked, 0o100);
    const result = bed.run();
    expect(result.stderr).not.toContain("Permission denied");
    expect(result.status).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    "recovers from a failed extraction that left a 0100 folder in the stage",
    () => {
      const root = makeRoot();
      const bed = installBed("r1", root);
      const failed = bed.run({ env: { EXTRACT_LEAVES_LOCKED: "1" } });
      expect(failed.status).toBe(1);
      expect(readdirSync(join(bed.app, "releases")).filter((n) => n.startsWith(".stage."))).toEqual([]);
      const second = bed.run();
      expect(second.stderr).not.toContain("Permission denied");
      expect(second.status).toBe(0);
      expect(readdirSync(join(bed.app, "releases")).filter((n) => n.startsWith(".stage."))).toEqual([]);
    },
  );

  it("keeps a successful install when an old release cannot be pruned", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    expect(installBed("r2", root).run({ args: ["--port", "7790"] }).status).toBe(0);
    const stuck = join(root.home, ".local/share/pap/releases/r0/sub");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "f"), "x");
    chmodSync(stuck, 0o500);
    try {
      const r3 = installBed("r3", root);
      const result = r3.run({ args: ["--port", "7790"] });
      expect(result.status).toBe(0);
      expect(current(r3.app)).toBe("releases/r3");
      expect(result.stderr).toContain("could not remove the old release r0");
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  it("still restores the previous release when removing the stage folder fails", () => {
    const root = makeRoot();
    expect(installBed("r1", root).run().status).toBe(0);
    const r2 = installBed("r2", root);
    const result = r2.run({ args: ["--port", "7790"], env: { NODE_EXIT: "1", FAIL_STAGE_RM: "1" } });
    expect(result.status).toBe(1);
    expect(current(r2.app)).toBe("releases/r1");
    expect(result.stderr).toContain("the previous release (r1) is back in place");
  });

  it("no longer looks for bubblewrap: agents run in microVMs", () => {
    const result = installBed("r1").run();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("bubblewrap");
  });
});
