import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoxOp } from "@pap/contracts";
import { ensureSigningAgent, stopSigningAgent } from "./github-agent.ts";
import { type ConfigEntry, editHomeConfig, editPrivateConfig } from "./github-config.ts";
import {
  credentialHelperOf,
  type GithubDeps,
  keyOf,
  publicKeyOf,
  signerOf,
  signingDirOf,
  testOriginOf,
  tokenFileOf,
} from "./github-env.ts";
import { removeHomeFile, writeHomeFile } from "./github-home.ts";
import { githubOf, type OpEnv, OpError } from "./paths.ts";

type Op<N extends BoxOp["name"]> = Extract<BoxOp, { name: N }>;

const KEYGEN_TIMEOUT_MS = 15_000;

/** Writes the box token to the tmpfs (0600, atomic) and points the home's git at the helper that reads it. */
export async function githubToken(env: OpEnv, op: Op<"github.token">): Promise<unknown> {
  const deps = githubOf(env);
  const file = tokenFileOf(deps);
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory()) throw new OpError("failed");
  chmodSync(folder, 0o700);
  const temporary = join(folder, `.token.${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(temporary, `${op.token}\n${op.expiresAt}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const origin = testOriginOf(deps);
  const helpers: ConfigEntry[] = [];
  for (const scope of ["https://github.com", ...(origin === null ? [] : [origin])]) {
    helpers.push([`credential.${scope}.helper`, "", `!${credentialHelperOf(deps)}`]);
  }
  await editHomeConfig(env, deps, helpers);
  return { ok: true };
}

const keygen = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("ssh-keygen", args, { encoding: "utf8", timeout: KEYGEN_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(new OpError("failed")) : resolve(stdout),
    );
  });

/** Everything git needs to sign: the public key, the agent-backed signer and the switch (the private key is not in the home). */
const signingEntries = (deps: GithubDeps): ConfigEntry[] => [
  ["gpg.format", "ssh"],
  ["user.signingkey", publicKeyOf(deps)],
  ["gpg.ssh.program", signerOf(deps)],
  ["commit.gpgsign", "true"],
];

/**
 * Makes the signing key once (in the box's guest-only folder, 0600), starts the agent holding it, writes the identity and the
 * signing settings (home and private config) and the public key into the home, and answers the public key.
 */
export async function githubIdentity(env: OpEnv, op: Op<"github.identity">): Promise<unknown> {
  const deps = githubOf(env);
  const key = keyOf(deps);
  mkdirSync(signingDirOf(deps), { recursive: true, mode: 0o700 });
  chmodSync(signingDirOf(deps), 0o700);
  if (!existsSync(key)) await keygen(["-q", "-t", "ed25519", "-N", "", "-C", "pap", "-f", key]);
  const publicKey = (await keygen(["-y", "-f", key])).trim();
  writeHomeFile(deps.home, ".ssh", "pap_signing.pub", `${publicKey}\n`, 0o644);
  const entries: ConfigEntry[] = [["user.name", op.login], ["user.email", op.email], ...signingEntries(deps)];
  await editHomeConfig(env, deps, entries);
  await editPrivateConfig(env, deps, entries);
  await ensureSigningAgent(deps);
  return { publicKey };
}

/** Stops the agent and removes the key and the signing settings; the identity stays. */
export async function githubForgetKey(env: OpEnv): Promise<unknown> {
  const deps = githubOf(env);
  stopSigningAgent(deps);
  rmSync(signingDirOf(deps), { recursive: true, force: true });
  const forgotten: ConfigEntry[] = ["gpg.format", "user.signingkey", "gpg.ssh.program", "commit.gpgsign"].map(
    (name) => [name],
  );
  await editHomeConfig(env, deps, forgotten);
  await editPrivateConfig(env, deps, forgotten);
  removeHomeFile(deps.home, ".ssh", "pap_signing.pub");
  return { ok: true };
}
