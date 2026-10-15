import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HelperContext } from "../ops.ts";
import { FALLBACK_PATH, SKILLS_CLI } from "@pap/contracts";
import { installEnv } from "./install-env.ts";
import { runInstall, SKILLS_CLI_BEFORE } from "./skills-install.ts";

let root: string;
let home: string;
let agentDir: string;
let cwd: string;
let bin: string;
let log: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-skinst-")));
  home = join(root, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(home, "work", "proj");
  bin = join(root, "bin");
  log = join(root, "ran.log");
  for (const dir of [agentDir, cwd, bin]) mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake `npx` first on the PATH: it records its argv, its folder and its environment, then exits. */
function fakeNpx(body = "") {
  const file = join(bin, "npx");
  writeFileSync(
    file,
    `#!/bin/sh\n{ printf 'ARGV'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; echo "CWD $(pwd)"; env | sed 's/^/ENV /'; } >> "${log}"\n${body}\n`,
  );
  chmodSync(file, 0o755);
}
const base = (): NodeJS.ProcessEnv => ({
  PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
  HOME: home,
  LANG: "C.UTF-8",
  PAP_HOME: "/secret/pap",
  PAP_TOKEN: "t",
  NODE_OPTIONS: "--require /evil.js",
  NOTIFY_SOCKET: "/run/notify",
  INVOCATION_ID: "abc",
});
const ctxFor = (
  target: string | null = cwd,
): Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal"> => ({
  agentDir,
  home,
  signal: new AbortController().signal,
  ...(target === null ? {} : { cwd: target }),
});
const confirm = { confirmProtected: true as const };
const trust = () => new ProjectTrustStore(agentDir).set(cwd, true);
const ran = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const argvOf = (text: string) =>
  text
    .split("\n")
    .find((l) => l.startsWith("ARGV"))
    ?.split("\t")
    .slice(1);
const cwdOf = (text: string) =>
  text
    .split("\n")
    .find((l) => l.startsWith("CWD "))
    ?.slice(4);
const envOf = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.startsWith("ENV "))
      .map((l) => l.slice(4).split(/=(.*)/s).slice(0, 2)),
  );
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? "other",
  );
const GLOBAL_ARGS = ["--yes", SKILLS_CLI, "add", "o/r", "-y", "--agent", "pi", "-g"];

describe("skills.install (M7R112, M7R140)", () => {
  it("runs the exact global command in the home folder", async () => {
    fakeNpx();
    expect(await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), { env: base() })).toEqual({
      ok: true,
    });
    expect(argvOf(ran())).toEqual(GLOBAL_ARGS);
    expect(cwdOf(ran())).toBe(home);
  });

  it("freezes the transitive dependencies at the CLI's release date plus two days (npm_config_before, MC55)", async () => {
    // skills@1.7.2 was published 2026-10-09: nothing published after 2026-10-11 can reach the install.
    // Pinned together: bumping the CLI without its date (or the date alone) fails here. The date is the release date + 2 days.
    expect([SKILLS_CLI, SKILLS_CLI_BEFORE]).toEqual(["skills@1.7.2", "2026-10-11T00:00:00.000Z"]);
    expect(new Date(SKILLS_CLI_BEFORE).toISOString()).toBe(SKILLS_CLI_BEFORE);
    fakeNpx();
    await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), {
      env: { ...base(), npm_config_before: "2030-01-01T00:00:00.000Z" },
    });
    expect(envOf(ran()).npm_config_before).toBe(SKILLS_CLI_BEFORE);
  });

  it("runs a project install in a trusted project with the confirmation: same array without -g, the project as folder", async () => {
    fakeNpx();
    trust();
    await runInstall({ source: "o/r", scope: "project", ...confirm }, ctxFor(), { env: base() });
    expect(argvOf(ran())).toEqual(GLOBAL_ARGS.slice(0, -1));
    expect(cwdOf(ran())).toBe(cwd);
  });

  it("refuses a project install in an untrusted project (project_untrusted) and never runs the fake", async () => {
    fakeNpx();
    expect(
      await codeOf(runInstall({ source: "o/r", scope: "project", ...confirm }, ctxFor(), { env: base() })),
    ).toBe("project_untrusted");
    new ProjectTrustStore(agentDir).set(cwd, false);
    expect(
      await codeOf(runInstall({ source: "o/r", scope: "project", ...confirm }, ctxFor(), { env: base() })),
    ).toBe("project_untrusted");
    expect(ran()).toBe("");
  });

  it("refuses a project install without the confirmation (protected_path) or without a folder (bad_params)", async () => {
    fakeNpx();
    trust();
    expect(await codeOf(runInstall({ source: "o/r", scope: "project" }, ctxFor(), { env: base() }))).toBe(
      "protected_path",
    );
    expect(
      await codeOf(
        runInstall({ source: "o/r", scope: "project", ...confirm }, ctxFor(null), { env: base() }),
      ),
    ).toBe("bad_params");
    expect(ran()).toBe("");
  });

  it("refuses a source that is an option, a path or another host, before anything runs", async () => {
    fakeNpx();
    for (const source of ["--registry=evil", "-g", "../x", "https://evil.test/o/r", "o/r --x", ""])
      expect(
        await codeOf(runInstall({ source, scope: "global" }, ctxFor(null), { env: base() })),
        source,
      ).toBe("bad_params");
    expect(ran()).toBe("");
  });

  it("spawns npx without a shell, with the binding options", async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const execFile = ((
      file: string,
      args: string[],
      options: Record<string, unknown>,
      done: (e: null, o: string, s: string) => void,
    ) => {
      calls.push({ file, args, options });
      done(null, "", "");
      return { kill: () => true };
    }) as never;
    await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), { env: base(), execFile });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("npx");
    expect(calls[0]?.args).toEqual(GLOBAL_ARGS);
    expect(calls[0]?.options).toMatchObject({
      cwd: home,
      shell: false,
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
    });
    expect(calls[0]?.options.shell).not.toBe(true);
  });

  it("kills a fake that runs past the deadline, and answers failed without its output", async () => {
    fakeNpx("echo SECRET-OUTPUT; exec sleep 30");
    const started = Date.now();
    expect(
      await codeOf(
        runInstall({ source: "o/r", scope: "global" }, ctxFor(null), {
          env: base(),
          timeoutMs: 1000,
          log: () => {},
        }),
      ),
    ).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("answers failed on a non-zero exit, keeps an 8 KiB tail for the log, and never puts the output in the error", async () => {
    fakeNpx("head -c 20000 /dev/zero | tr '\\0' 'x' >&2; echo SECRET-OUTPUT >&2; exit 3");
    const logged: string[] = [];
    const error = await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), {
      env: base(),
      log: (tail) => void logged.push(tail),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "failed" });
    expect(String((error as Error).message)).not.toContain("SECRET-OUTPUT");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("SECRET-OUTPUT");
    expect(logged[0]?.length).toBeLessThanOrEqual(8 * 1024);
  });

  it("masks credentials in the output tail before it is logged (N5)", async () => {
    fakeNpx(
      "echo 'npm ERR! fetch https://user:hunter2@registry.example/pkg' >&2; echo 'npm ERR! --token abc123def456' >&2; echo 'npm ERR! code E404' >&2; exit 1",
    );
    const logged: string[] = [];
    await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), {
      env: base(),
      log: (tail) => void logged.push(tail),
    }).catch(() => undefined);
    expect(logged[0]).not.toContain("hunter2");
    expect(logged[0]).not.toContain("abc123def456");
    expect(logged[0]).toContain("E404");
  });

  it("gives the child exactly the unattended environment, with absolute PATH entries only", async () => {
    fakeNpx();
    await runInstall({ source: "o/r", scope: "global" }, ctxFor(null), {
      env: {
        ...base(),
        PATH: `${bin}${delimiter}relative/bin${delimiter}${delimiter}./x${delimiter}/usr/bin`,
      },
    });
    const seen = envOf(ran());
    for (const key of Object.keys(seen)) expect(key).not.toMatch(/^PAP_/);
    for (const key of ["NODE_OPTIONS", "NOTIFY_SOCKET", "INVOCATION_ID"])
      expect(seen).not.toHaveProperty(key);
    expect(seen.PATH).toBe(`${bin}${delimiter}/usr/bin`);
    expect(seen.DISABLE_TELEMETRY).toBe("1");
    expect(seen.DO_NOT_TRACK).toBe("1");
  });

  it("builds the environment as a pinned value", () => {
    expect(installEnv(base(), home)).toEqual({
      PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
      HOME: home,
      LANG: "C.UTF-8",
      TERM: "dumb",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      npm_config_update_notifier: "false",
    });
    expect(installEnv({ PATH: "relative" }, home).PATH).toBe(FALLBACK_PATH);
    expect(installEnv({}, home).HOME).toBe(home);
  });
});
