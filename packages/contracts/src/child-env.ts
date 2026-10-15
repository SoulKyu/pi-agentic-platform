import { isDaemonOnlyEnvKey } from "./env-keys.ts";

/** An environment as `process.env` holds it (contracts has no Node types: the web compiles this file too). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Kept from the daemon's environment for every unattended child: who and where the owner is, and how text reads. */
const BASE_KEYS: readonly string[] = ["HOME", "USER", "LOGNAME", "LANG", "TZ"];
const BASE_PREFIXES: readonly string[] = ["LC_"];
/** When no absolute PATH entry is left: where the system's own tools are (M10's precheck rule). */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";
/** Proxies and CA bundles: what a child that reaches the network needs to get through the owner's network. */
export const NETWORK_ENV: readonly string[] = Object.freeze([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);
/** Where tools keep temporary files, configuration and caches (`XDG_*` is a prefix). */
export const TOOLING_ENV: readonly string[] = Object.freeze(["TMPDIR", "XDG_*"]);

const NEVER_NAMES: ReadonlySet<string> = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "GPG_AGENT_INFO",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
]);
/** Loader and git redirections, and the model providers' families (their keys and endpoints). */
const NEVER_PREFIXES: readonly string[] = [
  "GIT_",
  "LD_",
  "DYLD_",
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_",
  "AWS_",
  "GOOGLE_",
  "GEMINI_",
  "VERTEX_",
  "MISTRAL_",
  "GROQ_",
  "XAI_",
  "OPENROUTER_",
  "DEEPSEEK_",
  "CEREBRAS_",
  "HF_",
  "COPILOT_",
];
/** A name that reads as a credential: `GH_TOKEN`, `NPM_TOKEN`, `GITLAB_TOKEN`, `PGPASSWORD`, `MYSQL_PWD`, `X_API_KEY`… */
const SECRET_WORD =
  /(?:^|_)(?:API_?KEYS?|ACCESS_?KEYS?|SECRETS?|TOKENS?|CREDENTIALS?|PRIVATE_?KEYS?|AUTH)(?:_|$)|PASS(?:WORD|WD)|_PWD$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Never reaches an unattended child, even when a caller names it: the SSH agent, provider keys, forge tokens (c7). */
export const isNeverPassedEnvKey = (name: string): boolean =>
  isDaemonOnlyEnvKey(name) ||
  NEVER_NAMES.has(name) ||
  NEVER_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  SECRET_WORD.test(name);

export interface UnattendedExtra {
  /** More names kept from `base` when set: exact names, or a prefix written `XDG_*` (two characters at least). */
  readonly keep?: readonly string[];
  /** pap's own constants, set last (they win): lane variables, quiet flags. Never a value a caller read from `base`. */
  readonly set?: Readonly<Record<string, string>>;
}

/**
 * The environment of a child pap starts that no person watches (decision 81, owner c7): lane scripts and the forge CLI
 * (M9), the helper's `npx`, `npm` and `git` installs (M7), the automation precheck (M10). An allowlist: a name that is
 * not in `BASE_KEYS` or `keep` does not pass, and a never-passed name does not pass even when named in `keep`. `set` is
 * pap's own constants, applied last and outside that check (lane variables such as `PAP_LANE_ID`). PATH keeps its
 * absolute entries only (a relative one runs what a folder plants), else `FALLBACK_PATH`; `TERM` is `dumb`.
 */
export function unattendedEnv(base: EnvSource, extra: UnattendedExtra = {}): Record<string, string> {
  const exact = new Set(BASE_KEYS);
  const prefixes = [...BASE_PREFIXES];
  for (const name of extra.keep ?? []) {
    const prefix = name.endsWith("*") ? name.slice(0, -1) : null;
    if (prefix !== null && prefix.length >= 2 && NAME.test(prefix)) prefixes.push(prefix);
    else if (prefix === null && NAME.test(name)) exact.add(name);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key === "PATH" || isNeverPassedEnvKey(key)) continue;
    if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  const path = (base.PATH ?? "")
    .split(":")
    .filter((entry) => entry.startsWith("/"))
    .join(":");
  return { ...env, PATH: path === "" ? FALLBACK_PATH : path, TERM: "dumb", ...extra.set };
}
