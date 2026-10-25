import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { HELPER_OPS } from "@pap/contracts/pi-host";
import type { z } from "zod";
import { maskCommandLine } from "../mask.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { skillInstallArgs, skillSource } from "../skill-source.ts";
import { installEnv } from "./install-env.ts";
import { isTrusted } from "./models-open.ts";

type Ctx = Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal">;
type Params = z.infer<(typeof HELPER_OPS)["skills.install"]["params"]>;

/** M7R112: five minutes, an output tail of 8 KiB that is logged and never returned. */
export const INSTALL_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const MAX_BUFFER = 1024 * 1024;
/**
 * `skills@1.7.2` was published 2026-10-09 (skill-source.ts); two days later. `npm_config_before` makes npm resolve the CLI's
 * transitive dependencies as of that date, so nothing published afterwards can reach the install (minimumReleaseAge, MC55).
 */
export const SKILLS_CLI_BEFORE = "2026-10-11T00:00:00.000Z";

/** The output of npm may hold a registry URL with credentials or a token: each line goes through the helper's word masker before it is logged. */
export const maskOutput = (tail: string): string => tail.split("\n").map(maskCommandLine).join("\n");

const logTail = (tail: string): void =>
  void process.stderr.write(`pi-helper: skills install output tail:\n${tail}\n`);

export interface InstallDeps {
  readonly execFile?: typeof nodeExecFile;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Where the output tail of a failed install goes (the helper's stderr, which the daemon logs clipped). */
  readonly log?: (tail: string) => void;
}

/**
 * Installs from skills.sh through the pinned CLI (M7R112): `npx` with no shell, the source validated, `-g` for the owner's
 * Pi folder. A project install needs the protected-file confirmation and a trusted project, and runs in its folder (M7R140).
 * The output is kept as a tail for the log on failure and is never part of an answer.
 */
export async function runInstall(params: Params, ctx: Ctx, deps: InstallDeps = {}): Promise<{ ok: true }> {
  const source = skillSource(params.source);
  if (source === null) throw new HelperOpError("bad_params", "source");
  let cwd = ctx.home;
  if (params.scope === "project") {
    if (ctx.cwd === undefined) throw new HelperOpError("bad_params", "cwd");
    if (params.confirmProtected !== true) throw new HelperOpError("protected_path");
    const real = await fs.realpath(ctx.cwd).catch(() => null);
    if (real === null) throw new HelperOpError("bad_params", "cwd");
    if (!isTrusted(ctx.agentDir, real)) throw new HelperOpError("project_untrusted");
    cwd = real;
  }
  const run = deps.execFile ?? nodeExecFile;
  const env = {
    ...installEnv(deps.env ?? process.env, ctx.home, ctx.agentDir),
    npm_config_before: SKILLS_CLI_BEFORE,
  };
  await new Promise<void>((resolve, reject) => {
    run(
      "npx",
      skillInstallArgs(source, params.scope),
      {
        cwd,
        env,
        shell: false,
        timeout: deps.timeoutMs ?? INSTALL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        killSignal: "SIGKILL",
        signal: ctx.signal,
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve();
        const tail = `${String(stdout)}${String(stderr)}`.slice(-OUTPUT_TAIL_BYTES);
        if (tail !== "") (deps.log ?? logTail)(maskOutput(tail));
        const why = error.killed ? "killed (deadline or cancel)" : `exit ${String(error.code ?? "unknown")}`;
        reject(new HelperOpError("failed", `skills install ${why}`));
      },
    );
  });
  return { ok: true };
}

export const skillsInstallOp = defineOp({
  params: HELPER_OPS["skills.install"].params,
  run: (params, ctx) => runInstall(params, ctx),
});
