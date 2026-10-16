import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSystemd } from "../testing/fake-systemd.ts";

const MAIN = fileURLToPath(new URL("../../main.ts", import.meta.url));
const ID = "0123456789abcdef0123456789abcdef";
const SETUP = '{"msg":"setup_url","url":"http://localhost:7777/setup?token=canned-token"}';
const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let home: string;
let nodeBin: string;
let mainFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-svc-rec-"));
  fake = fakeSystemd(join(scratch, "fake"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  nodeBin = join(fake.binDir, "node");
  mainFile = join(scratch, "app", "main.js");
  mkdirSync(dirname(mainFile), { recursive: true });
  writeFileSync(mainFile, "// main\n");
  env = { PATH: `${fake.binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8" };
  fake.set("linger", "yes\n");
  fake.set("node-version", "v24.14.0\n");
  fake.set("invocation-id", `${ID}\n`);
  fake.set("journal", `${SETUP}\n${LISTENING}\n`);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const install = (...extra: string[]) =>
  spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      MAIN,
      ...["service", "install", "--node", nodeBin, "--main", mainFile, ...extra],
    ],
    { env, encoding: "utf8", timeout: 55_000 },
  );
const unitFile = () => join(home, ".config", "systemd", "user", "pap.service");
const launcher = () => join(home, ".local", "bin", "pap");
const all = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
const neverListens = () => fake.set("journal", '{"msg":"boot"}\n');

describe("pap service install recovery", () => {
  it("I1: reset-failed runs before restart, so the start limit cannot refuse the retry", () => {
    const result = install();
    expect(result.status, all(result)).toBe(0);
    const calls = fake.calls();
    const reset = calls.indexOf("systemctl --user reset-failed pap.service");
    const restart = calls.indexOf("systemctl --user restart pap.service");
    expect(reset).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(reset);
  });

  it("I1: a refused reset-failed does not stop the install", () => {
    fake.set("fail-reset-failed", "");
    const result = install();
    expect(result.status, all(result)).toBe(0);
  });

  it("I2: an unreadable journal exits 3 with its own sentence, not 'did not start listening'", () => {
    fake.set("journal", "");
    fake.set("journal-any", "");
    const result = install();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("the user journal is not readable");
    expect(result.stderr).toContain("systemctl --user status pap");
    expect(result.stderr).not.toContain("did not start listening");
    expect(result.stdout).not.toContain("http://");
    expect(existsSync(unitFile())).toBe(true);
    expect(fake.calls().some((c) => c.includes(" disable "))).toBe(false);
  });

  it("I2: a journal that shows the manager's own lines but no listening is a real failure (exit 1)", () => {
    neverListens();
    fake.set("journal-any", "Started pap.service.\n");
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pap did not start listening");
  });

  it("M2: a first install that never listens stops and disables the unit and lists what remains with the undo commands", () => {
    neverListens();
    const result = install();
    expect(result.status).toBe(1);
    const calls = fake.calls();
    const stop = calls.indexOf("systemctl --user stop pap.service");
    expect(stop).toBeGreaterThan(-1);
    expect(calls.indexOf("systemctl --user disable pap.service")).toBeGreaterThan(stop);
    expect(result.stderr).toContain("at boot (with linger) or at login");
    expect(result.stderr).toContain(`rm '${unitFile()}' '${launcher()}'`);
    expect(result.stderr).toContain("systemctl --user stop pap.service");
    expect(result.stderr).toContain("systemctl --user daemon-reload");
  });

  it("M2: undo paths are quoted, whatever the config folder holds", () => {
    neverListens();
    env.XDG_CONFIG_HOME = join(scratch, "conf dir");
    const result = install();
    expect(result.stderr).toContain(`rm '${join(scratch, "conf dir", "systemd", "user", "pap.service")}' `);
  });

  it("M2: the same failing first install twice leaves the unit disabled both times", () => {
    neverListens();
    expect(install().status).toBe(1);
    expect(install().status).toBe(1);
    const disables = fake.calls().filter((c) => c === "systemctl --user disable pap.service");
    expect(disables).toHaveLength(2);
    expect(fake.calls().at(-1)).not.toContain("enable pap.service");
    expect(readFileSync(join(scratch, "fake", "answers", "enabled"), "utf8")).toBe("no\n");
  });

  it("M2: a reinstall over an enabled unit that never listens keeps it enabled and prints no undo list", () => {
    fake.set("enabled", "yes\n");
    neverListens();
    const result = install();
    expect(result.status).toBe(1);
    expect(fake.calls().some((c) => c.includes(" disable "))).toBe(false);
    expect(fake.calls().some((c) => c.includes(" stop "))).toBe(false);
    expect(result.stderr).not.toContain("rm ");
  });

  it("M4: warns when PAP_HOME is set without --home, and not otherwise", () => {
    env.PAP_HOME = join(scratch, "elsewhere");
    expect(install().stderr).toContain("PAP_HOME is set but the service ignores it");
    expect(install("--home", join(scratch, "h2")).stderr).not.toContain("PAP_HOME");
    delete env.PAP_HOME;
    expect(install().stderr).not.toContain("PAP_HOME");
  });
});
