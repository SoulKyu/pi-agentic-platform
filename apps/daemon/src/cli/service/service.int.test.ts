import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { LAUNCHER_MARK } from "./launcher.ts";

const MAIN = fileURLToPath(new URL("../../main.ts", import.meta.url));
const ID = "0123456789abcdef0123456789abcdef";
const SETUP_URL = "http://localhost:7777/setup?token=canned-token";
const SETUP = `{"msg":"setup_url","url":"${SETUP_URL}"}`;
const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const HINT = "journalctl --user -u pap -n 30";

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let home: string;
let papHome: string;
let nodeBin: string;
let mainFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-svc-"));
  fake = fakeSystemd(join(scratch, "fake"));
  home = join(scratch, "home");
  papHome = join(scratch, "pap-home");
  mkdirSync(home, { recursive: true });
  mkdirSync(papHome, { recursive: true });
  writeFileSync(join(papHome, "state.db"), Buffer.from([0, 1, 2, 3, 250, 251]));
  utimesSync(join(papHome, "state.db"), 1_700_000_000, 1_700_000_000);
  nodeBin = join(fake.binDir, "node");
  mainFile = join(scratch, "app", "main.js");
  mkdirSync(dirname(mainFile), { recursive: true });
  writeFileSync(mainFile, "// main\n");
  env = {
    PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C.UTF-8",
    PAP_HOME: papHome,
  };
  fake.set("linger", "yes\n");
  fake.set("node-version", "v24.14.0\n");
  fake.set("invocation-id", `${ID}\n`);
  fake.set("journal", `${SETUP}\n${LISTENING}\n`);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const pap = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN, ...args],
    { env, encoding: "utf8", timeout: 55_000 },
  );
const install = (...extra: string[]) =>
  pap(["service", "install", "--node", nodeBin, "--main", mainFile, ...extra]);
const unitFile = () => join(home, ".config", "systemd", "user", "pap.service");
const launcher = () => join(home, ".local", "bin", "pap");
const all = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
const mode = (path: string) => statSync(path).mode & 0o777;
const sentinel = () => {
  const stat = statSync(join(papHome, "state.db"));
  return { bytes: readFileSync(join(papHome, "state.db")).toString("hex"), mtime: stat.mtimeMs };
};
const journalCalls = () => fake.calls().filter((c) => c.startsWith("journalctl"));

describe("pap service install", () => {
  it("1: installs a fresh unit and launcher, restarts, waits for listening", () => {
    fake.set("active", "no\n");
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(fake.calls().slice(0, -1)).toEqual([
      "node --version",
      "systemctl --user show-environment",
      `loginctl show-user ${process.getuid?.()} --property=Linger --value`,
      "systemctl --user daemon-reload",
      "systemctl --user is-enabled --quiet pap.service",
      "systemctl --user enable pap.service",
      "systemctl --user is-active --quiet pap.service",
      "systemctl --user reset-failed pap.service",
      "systemctl --user restart pap.service",
      "systemctl --user show -p InvocationID --value pap.service",
    ]);
    expect(fake.calls().at(-1)).toMatch(/^journalctl /);
    expect(mode(unitFile())).toBe(0o644);
    expect(readFileSync(unitFile(), "utf8")).toContain(
      `ExecStart=${nodeBin} --disable-warning=ExperimentalWarning ${mainFile} serve\n`,
    );
    expect(mode(launcher())).toBe(0o755);
    expect(readFileSync(launcher(), "utf8")).toContain(LAUNCHER_MARK);
    expect(result.stdout).toContain(SETUP_URL);
    expect(result.stdout).toContain("ssh -L 7777:localhost:7777 <you>@<host>");
    expect(result.stdout).toContain(`\`pap\` command: ${launcher()}`);
    expect(result.stdout).toContain("is not on your PATH; use the full path above or add it yourself");
    expect(result.stdout).not.toContain("restarted");
  });

  it("2: reinstalling over an active service restarts it and leaves the data alone", () => {
    fake.set("active", "yes\n");
    const before = sentinel();
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(result.stdout).toContain("pap was running and has been restarted; running turns were interrupted");
    expect(sentinel()).toEqual(before);
  });

  it("3a: linger off and refused is a warning with the exact command, exit 0", () => {
    fake.set("linger", "no\n");
    fake.set("fail-enable-linger", "");
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(result.stderr).toContain(`loginctl enable-linger ${userInfo().username}`);
    expect(fake.calls()).toContain("loginctl enable-linger");
  });

  it("3b: linger off then enabled by the installer prints no warning", () => {
    fake.set("linger", "no\n");
    fake.set("linger-after-enable", "yes\n");
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(all(result)).not.toContain("enable-linger");
    expect(fake.calls().filter((c) => c.startsWith("loginctl"))).toEqual([
      `loginctl show-user ${process.getuid?.()} --property=Linger --value`,
      "loginctl enable-linger",
      `loginctl show-user ${process.getuid?.()} --property=Linger --value`,
    ]);
  });

  it("4: no user manager writes nothing and never reloads", () => {
    fake.set("fail-show-environment", "");
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "no systemd user manager: log in with a full session or set XDG_RUNTIME_DIR=/run/user/",
    );
    expect(existsSync(unitFile())).toBe(false);
    expect(existsSync(launcher())).toBe(false);
    expect(fake.calls().some((c) => c.includes("daemon-reload"))).toBe(false);
  });

  it.each(["--main", "--home", "--bin-dir"])(
    "5: %s with a space is refused by name and nothing is written (the file exists, so only safePath can refuse it)",
    (flag) => {
      const spaced = join(scratch, "sp ace");
      mkdirSync(spaced, { recursive: true });
      const spacedMain = join(spaced, "main.js");
      writeFileSync(spacedMain, "// main\n");
      const args = ["service", "install", "--node", nodeBin, "--main", mainFile];
      args[args.indexOf("--main") + 1] = flag === "--main" ? spacedMain : mainFile;
      if (flag === "--home") args.push("--home", spaced);
      if (flag === "--bin-dir") args.push("--bin-dir", spaced);
      const result = pap(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `pap: ${flag} must be an absolute path of letters, digits and . _ + @ / - only\n`,
      );
      expect(result.stderr).not.toContain("sp ace");
      expect(existsSync(unitFile())).toBe(false);
      expect(existsSync(launcher())).toBe(false);
      expect(existsSync(join(spaced, "pap"))).toBe(false);
    },
  );

  it.each(["0", "65536", "abc", "-1"])("5b: --port %s is a usage error and writes nothing", (port) => {
    const result = install("--port", port);
    expect(result.status).toBe(64);
    expect(existsSync(unitFile())).toBe(false);
    expect(fake.calls().filter((c) => c.startsWith("systemctl"))).toEqual([]);
  });

  it.each(["restart", "daemon-reload", "enable"])(
    "5c: a failed systemctl %s says so with the exit code and the journal hint, never the child's stderr",
    (verb) => {
      fake.set(`fail-${verb}`, "");
      const result = install();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`systemctl ${verb} failed (exit 1); see: ${HINT}`);
      expect(all(result)).not.toContain("SECRET-STDERR");
    },
  );

  it("6: Node 22 is refused and writes nothing", () => {
    fake.set("node-version", "v22.1.0\n");
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--node");
    expect(existsSync(unitFile())).toBe(false);
  });

  it.each(["yes", "no"])(
    "7: a daemon that never binds exits 1 with the hint, no URL and no owner claim (is-active %s)",
    (active) => {
      fake.set("active", `${active}\n`);
      fake.set("journal", '{"msg":"boot"}\n');
      const result = install();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`pap did not start listening; see: ${HINT}`);
      expect(all(result)).not.toContain("http://");
      expect(all(result)).not.toContain("owner");
      expect(journalCalls()).toHaveLength(41); // 40 matched reads, then one unmatched read that tells "never" from "unreadable"
    },
  );

  it("8: listening without a setup URL means an owner exists, after two consecutive journal reads", () => {
    fake.set("active", "yes\n");
    fake.set("journal", `${LISTENING}\n`);
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(result.stdout).toContain("an owner already exists: open http://localhost:7777");
    expect(result.stdout).toContain("pap service url");
    expect(result.stdout).not.toContain("setup URL");
    expect(journalCalls()).toHaveLength(2);
  });

  it("9: --port, --home and --bin-dir reach the unit and the launcher", () => {
    const bin = join(scratch, "b");
    fake.set("journal", `{"msg":"setup_url","url":"http://localhost:7790/setup?token=t"}\n${LISTENING}\n`);
    const result = install("--port", "7790", "--home", "/tmp/x/home", "--bin-dir", bin);
    expect(result.status, all(result)).toBe(0);
    const unit = readFileSync(unitFile(), "utf8");
    expect(unit).toContain("serve --port 7790\n");
    expect(unit).toContain("Environment=PAP_HOME=/tmp/x/home\n");
    expect(readFileSync(join(bin, "pap"), "utf8")).toContain("PAP_HOME='/tmp/x/home'");
    expect(existsSync(launcher())).toBe(false);
    expect(result.stdout).toContain("7790");
    expect(result.stdout).toContain("/tmp/x/home");
  });

  it("10: a foreign launcher is kept byte for byte and named in a warning", () => {
    mkdirSync(dirname(launcher()), { recursive: true });
    writeFileSync(launcher(), "#!/bin/sh\necho mine\n");
    const result = install();
    expect(result.status, all(result)).toBe(0);
    expect(readFileSync(launcher(), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(result.stderr).toContain(launcher());
    expect(result.stdout).toContain(`'${nodeBin}' --disable-warning=ExperimentalWarning '${mainFile}'`);
    expect(existsSync(unitFile())).toBe(true);
  });
});

describe("pap service uninstall and url", () => {
  it("11a: uninstall removes the unit and our launcher, never the data, and is repeatable", () => {
    expect(install("--home", "/tmp/x/used-home").status).toBe(0);
    fake.set("load-state", "loaded\n");
    const before = sentinel();
    const first = pap(["service", "uninstall"]);
    expect(first.status, all(first)).toBe(0);
    expect(existsSync(unitFile())).toBe(false);
    expect(existsSync(launcher())).toBe(false);
    const calls = fake.calls();
    const stop = calls.indexOf("systemctl --user stop pap.service");
    const disable = calls.indexOf("systemctl --user disable pap.service");
    const reload = calls.lastIndexOf("systemctl --user daemon-reload");
    expect(stop).toBeGreaterThan(-1);
    expect(disable).toBeGreaterThan(stop);
    expect(reload).toBeGreaterThan(disable);
    expect(first.stdout).toContain("your data stays in /tmp/x/used-home");
    expect(first.stdout).not.toContain(papHome);
    expect(sentinel()).toEqual(before);
    expect(pap(["service", "uninstall"]).status).toBe(0);
  });

  it("11b: uninstall leaves a foreign launcher alone and works when nothing was installed", () => {
    mkdirSync(dirname(launcher()), { recursive: true });
    writeFileSync(launcher(), "#!/bin/sh\necho mine\n");
    fake.set("load-state", "not-found\n");
    fake.set("fail-stop", "");
    fake.set("fail-disable", "");
    const result = pap(["service", "uninstall"]);
    expect(result.status, all(result)).toBe(0);
    expect(result.stdout).toContain("no pap service was installed");
    expect(fake.calls().some((c) => c.includes(" stop "))).toBe(false);
    expect(readFileSync(launcher(), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("11d: uninstall without a user manager refuses and removes nothing", () => {
    expect(install().status).toBe(0);
    fake.set("fail-show-environment", "");
    const result = pap(["service", "uninstall"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing was removed");
    expect(existsSync(unitFile())).toBe(true);
    expect(existsSync(launcher())).toBe(true);
    expect(fake.calls().some((c) => c.includes(" stop "))).toBe(false);
  });

  it.each(["stop", "disable"])(
    "11e: a failed %s keeps the unit file and the launcher and says so",
    (verb) => {
      expect(install().status).toBe(0);
      fake.set("load-state", "loaded\n");
      fake.set(`fail-${verb}`, "");
      const result = pap(["service", "uninstall"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`systemctl ${verb} failed (exit 1); see: ${HINT}`);
      expect(existsSync(unitFile())).toBe(true);
      expect(existsSync(launcher())).toBe(true);
      expect(result.stdout).not.toContain("removed");
    },
  );

  it("11c: url prints the setup URL, the owner guidance or the not-listening guidance, exit 0", () => {
    fake.set("active-enter", "Thu 2026-10-15 18:20:11 UTC\n");
    const withUrl = pap(["service", "url"]);
    expect(withUrl.status, all(withUrl)).toBe(0);
    expect(withUrl.stdout).toContain(SETUP_URL);
    fake.set("journal", `${LISTENING}\n`);
    const owner = pap(["service", "url"]);
    expect(owner.status).toBe(0);
    expect(owner.stdout).toContain("an owner already exists");
    expect(owner.stdout).not.toContain("http://localhost:7777/setup");
    rmSync(join(scratch, "fake", "answers", "journal"));
    const empty = pap(["service", "url"]);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("not listening");
    expect(empty.stdout).toContain(HINT);
  });

  it("11f: url never shows a URL or an owner claim from an earlier start of the service", () => {
    // Two invocations: the earlier one logged a URL; the current one (started 18:20:11) has logged nothing yet.
    fake.set("journal", "");
    fake.set("journal-since", `${SETUP}\n${LISTENING}\n`); // what a wider window than the current start would return
    fake.set("journal-since@2026-10-15 18:20:11 UTC", "");
    fake.set("active-enter", "Thu 2026-10-15 18:20:11 UTC\n");
    const bounded = pap(["service", "url"]);
    expect(bounded.status, all(bounded)).toBe(0);
    expect(bounded.stdout).not.toContain(SETUP_URL);
    expect(bounded.stdout).toContain("not listening yet");
    expect(journalCalls().at(-1)).toContain("--since 2026-10-15 18:20:11 UTC");
    fake.set("active-enter", "");
    const unknown = pap(["service", "url"]);
    expect(unknown.stdout).toContain("not listening yet");
    expect(unknown.stdout).not.toContain(SETUP_URL);
  });
});
