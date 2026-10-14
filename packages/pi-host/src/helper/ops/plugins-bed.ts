import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { HelperOpError, type HelperContext } from "../ops.ts";
import { fakeInstallers } from "./offline-bed.ts";

/** The bed of the plugin op tests: a temporary home with a local package folder, fake `npm` and `git` first on the PATH. */
export let root: string;
export let home: string;
export let agentDir: string;
export let cwd: string;
export let pkg: string;
export let bin: string;
export let log: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-plugins-")));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(home, "work", "proj");
  pkg = join(home, "pkgs", "tools");
  bin = join(root, "bin");
  log = join(root, "ran.log");
  for (const dir of [agentDir, cwd, join(pkg, "skills", "hello")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tools", version: "1.0.0" }));
  writeFileSync(
    join(pkg, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: says hello\n---\n# hello\n",
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", fakeInstallers(bin, log));
  blockedAttempts.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});

export const ctxFor = (
  target: string | null = cwd,
): Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal"> => ({
  agentDir,
  home,
  signal: new AbortController().signal,
  ...(target === null ? {} : { cwd: target }),
});
export const confirm = { confirmProtected: true as const };
export const trust = () => new ProjectTrustStore(agentDir).set(cwd, true);
export const settingsOf = (path: string): { packages?: unknown[] } =>
  JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown[] };
export const globalSettings = () => settingsOf(join(agentDir, "settings.json"));
export const projectSettings = () => settingsOf(join(cwd, ".pi", "settings.json"));
export const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );
export const off = { extensions: [], skills: [], prompts: [], themes: [] };
export const local = (dir: string) => join("..", "..", "pkgs", dir);
