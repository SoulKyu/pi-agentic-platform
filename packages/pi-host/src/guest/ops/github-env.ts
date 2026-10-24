import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOX_GITHUB_TIMEOUTS } from "@pap/contracts";
import { proxyEnv } from "../../vm-shell/proxy-env.ts";
import type { GitOptions } from "./git-run.ts";
import { OpError } from "./paths.ts";

/** What the GitHub ops need of the guest beyond the project: the home, the tmpfs, the wrapper scripts and the environment. */
export interface GithubDeps {
  readonly home: string;
  /** `/run`, or the box's run folder on the process backend (`PAP_GUEST_RUN_DIR`). */
  readonly runDir: string;
  /** The folder of `gh`, `pap-git-credential` and `pap-ssh-sign` (the bundle's `bin`). */
  readonly binDir: string;
  /** The guest's own environment: the proxy address and the test origin are read from it. */
  readonly env: NodeJS.ProcessEnv;
}

/** The bundle's `bin`, from `src/guest/ops` or `dist/guest/ops` alike (the image copies the bundle to `/opt/pap/pi-host`). */
export const BUNDLE_BIN = fileURLToPath(new URL("../../../bin", import.meta.url));

export const tokenFileOf = (deps: GithubDeps): string => join(deps.runDir, "pap-github", "token");
/** Guest-only state of the box, beside `project/` and `home/`: no session shell binds it (R8). */
export const boxPrivateOf = (deps: GithubDeps): string => join(dirname(deps.home), ".pap");
/** The signing private key lives here, never under the home; deleting the folder is forgetting the key. */
export const signingDirOf = (deps: GithubDeps): string => join(boxPrivateOf(deps), "signing");
export const keyOf = (deps: GithubDeps): string => join(signingDirOf(deps), "pap_signing");
/** The public half stays in the home, where git and the owner can read it. */
export const publicKeyOf = (deps: GithubDeps): string => join(deps.home, ".ssh", "pap_signing.pub");
/** The identity and signing settings the daemon-initiated commits read: the home's `.gitconfig` is the session's to edit. */
export const privateConfigOf = (deps: GithubDeps): string => join(boxPrivateOf(deps), "github.gitconfig");
/** The signing agent's socket, in the folder a session shell sees read-only (a connect works on a read-only bind). */
export const agentSocketOf = (deps: GithubDeps): string => join(deps.runDir, "pap-github", "agent.sock");
export const signerOf = (deps: GithubDeps): string => join(deps.binDir, "pap-ssh-sign");
export const credentialHelperOf = (deps: GithubDeps): string => join(deps.binDir, "pap-git-credential");

/** The fake GitHub's origin: only a guest started by the process backend of a test run has one. */
export const testOriginOf = (deps: GithubDeps): string | null => deps.env.PAP_TEST_GITHUB_ORIGIN || null;

/** A real GitHub URL, or (with a test origin) the loopback forms of the fake: anything else is refused. */
export function assertRemoteUrl(deps: GithubDeps, url: string): void {
  if (url.startsWith("https://github.com/")) return;
  if (testOriginOf(deps) === null) throw new OpError("bad_request");
}

/** The proxy variables of the guest's egress proxy, when it has one. */
export function proxyEnvOf(deps: GithubDeps): Record<string, string> {
  const proxy = deps.env.PAP_GUEST_PROXY;
  if (!proxy) return {};
  const gateway = deps.env.PAP_GATEWAY;
  return proxyEnv(
    `http://${proxy}`,
    gateway === undefined ? undefined : gateway.slice(0, gateway.lastIndexOf(":")),
  );
}

/** The environment of a network call: the box's home, the token's folder, the proxy, and the fake's origin for the helper. */
export function networkEnvOf(deps: GithubDeps): Record<string, string> {
  const origin = testOriginOf(deps);
  return {
    HOME: deps.home,
    PAP_GUEST_RUN_DIR: deps.runDir,
    ...proxyEnvOf(deps),
    ...(origin === null ? {} : { PAP_TEST_GITHUB_ORIGIN: origin }),
  };
}

/**
 * A network git call (clone, push): the `remote` profile, https only (and the fake's http and file with a test origin), and one
 * credential helper scoped to github.com (and the test origin), set after the repository's own so it replaces them.
 */
export function networkGit(deps: GithubDeps, name: keyof typeof BOX_GITHUB_TIMEOUTS): GitOptions {
  const origin = testOriginOf(deps);
  const helper = `!${credentialHelperOf(deps)}`;
  const scopes = ["https://github.com", ...(origin === null ? [] : [origin])];
  return {
    timeoutMs: BOX_GITHUB_TIMEOUTS[name],
    config: ["credential.helper=", ...scopes.map((scope) => `credential.${scope}.helper=${helper}`)],
    remote: { protocols: origin === null ? "https" : "https:http:file", env: networkEnvOf(deps) },
  };
}
