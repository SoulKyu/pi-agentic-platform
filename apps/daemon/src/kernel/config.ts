import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createSecureContext } from "node:tls";
import { parseArgs } from "node:util";
import { type OtlpConfig, parseOtlp } from "./config-otlp.ts";
import { parsePush, type PushEnv } from "./config-push.ts";
import type { LogLevel } from "./logger.ts";
import { type OutboxHold, parseOutboxHold } from "./outbox/hold.ts";
import { defaultMemoryMaxMb, type ScopeLimits } from "./supervisor/scope.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const DEFAULT_MIN_FREE_MEM_MB = 512;
const DEFAULT_MAX_TERMINALS = 8;
const MAX_TERMINALS_LIMIT = 64;
// Timers hold at most 2^31 - 1 ms; a longer idle delay would fire at once.
const MAX_IDLE_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);
/** `PAP_METRICS_TOKEN`: unset turns `/metrics` off (404); a value outside this shape stops the daemon at boot (ConfigError). */
export const METRICS_TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
export const VITE_DEV_ORIGIN = "http://localhost:5173";
// docs/spikes/s4-m2-long-session.md: a 300-turn session with compaction on, run with WORKER_SEMI_SPACE_FLAG (owner, R45).
export const WORKER_BUDGET_MB = 285;

// Messages are fixed text: no flag value, environment value or path is ever echoed (spec C §4.1),
// so a mistyped secret cannot reach a terminal, a log line or a crash report through a config error.
export type { OtlpConfig, OutboxHold };

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config extends PushEnv {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly dev: boolean;
  /** The certificate and key as read at start-up (PEM); the server never reads the files again. */
  readonly tls: { readonly cert: Buffer; readonly key: Buffer } | null;
  /** `--insecure-http`: session cookies without Secure on plain HTTP, so a LAN address works for testing. */
  readonly insecureHttp: boolean;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly piAgentDir: string;
  /** The daemon user's home folder (`os.homedir()`): the path boundary protects its dot-entries (M8R118). */
  readonly userHome: string;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly testProviderScript: string | null;
  /** Test-only transports for a push (`PAP_TEST_GIT_PROTOCOLS`, with the scripted provider): `file` reaches a local bare repository (M9R10). */
  readonly testGitProtocols: string | null;
  /** `PAP_TEST_OUTBOX_HOLD`, read only beside `PAP_TEST_PROVIDER_SCRIPT`: where a test freezes an effect for a crash (M10R80). */
  readonly testOutboxHold?: OutboxHold | null;
  readonly maxWorkers: number;
  readonly minFreeMemMb: number;
  /** `PAP_MIN_FREE_DISK_MB`: new forks, task sessions and the lane paths (create, restore, review, compare, suggest) are refused with `disk_low` below this much free disk; 0 is off for all of them (M10R101, M9R117). */
  readonly minFreeDiskMb: number;
  /** Running terminals per owner (`PAP_MAX_TERMINALS`, 1-64, M8R66). */
  readonly maxTerminals: number;
  /** A worker with nothing to do is released after this long; 0 never releases (`PAP_WORKER_IDLE_MINUTES`). */
  readonly workerIdleMs: number;
  /** `auto` puts each worker in a systemd user scope when a lingering user manager answers; `off` never does. */
  readonly workerScope: "auto" | "off";
  readonly workerLimits: ScopeLimits;
  /** At most this many Pi configuration helpers run at once; one more is refused (`PAP_HELPERS_MAX`, 1-16). */
  readonly helpersMax: number;
  /** `PAP_METRICS_TOKEN`: the bearer of `GET /metrics`; null turns the route off (M10R95). */
  readonly metricsToken: string | null;
  /** `PAP_OTLP_ENDPOINT` and its companions; null (the default) means no exporter exists (M10R98). */
  readonly otlp: OtlpConfig | null;
  /** `PAP_BWRAP`: an absolute path the sandbox probe must trust (M11R21); undefined looks in the system folders. */
  readonly bwrapOverride?: string | undefined;
  readonly staticRoot: string | null;
  readonly logLevel: LogLevel;
}

export interface ConfigInput {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homedir: string;
  readonly totalMemMb: number;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly staticRoot: string | null;
}

const BAD_HOST_CHARS = /[\s/\\@?#]/;

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";
const isWildcard = (host: string) => host === "0.0.0.0" || host === "::";

/**
 * Part of what `WORKER_BUDGET_MB` was measured with (docs/spikes/s4-m2-long-session.md): it caps V8's semi-space
 * at 16 MiB, which brought the measured RSS of a long session down. It is a command-line flag (which takes
 * precedence over `NODE_OPTIONS`) and it is always appended here, never inherited from the daemon.
 */
export const WORKER_SEMI_SPACE_FLAG = "--max-semi-space-size=16";

/**
 * The node flags a worker inherits from the daemon: the development condition (`--conditions=development`, so a
 * worker finds the TypeScript sources too) and nothing else. In particular no `--import`: a worker starts in the
 * session's project, where a relative or bare specifier would load the project's own code before the policy runs.
 */
export function workerExecArgv(execArgv: readonly string[]): string[] {
  // `=` form only: a lone `--conditions` would take the worker entry path as its value.
  return [...execArgv.filter((arg) => arg.startsWith("--conditions=")), WORKER_SEMI_SPACE_FLAG];
}

export function defaultMaxWorkers(totalMemMb: number, budgetMb = WORKER_BUDGET_MB): number {
  return Math.min(16, Math.max(2, Math.floor((totalMemMb * 0.5) / budgetMb)));
}

export function loadConfig(input: ConfigInput): Config {
  const values = parseFlags(input.argv);
  const dev = values.dev === true;
  const devId = dev ? createHash("sha256").update(realpathSync(input.cwd)).digest("hex").slice(0, 8) : null;
  const host = values.host === undefined ? DEFAULT_HOST : parseHost(values.host);
  const port =
    values.port !== undefined
      ? parsePort(values.port)
      : devId
        ? 20_000 + (Number.parseInt(devId.slice(0, 4), 16) % 10_000)
        : DEFAULT_PORT;
  const cert = values["tls-cert"];
  const key = values["tls-key"];
  if ((cert === undefined) !== (key === undefined))
    throw new ConfigError("--tls-cert and --tls-key go together");
  const insecureHttp = values["insecure-http"] === true;
  if (insecureHttp && (cert !== undefined || key !== undefined))
    throw new ConfigError("--insecure-http is for plain HTTP; drop it when serving TLS");
  const tls = cert !== undefined && key !== undefined ? readTls(cert, key) : null;
  const scheme = tls ? "https" : "http";
  const local = isLoopback(host) || isWildcard(host);
  const publicOrigin = input.env.PAP_PUBLIC_ORIGIN
    ? parseOrigin(input.env.PAP_PUBLIC_ORIGIN)
    : originOf(scheme, local ? "localhost" : host, port);
  const allowedOrigins = new Set([publicOrigin]);
  if (local)
    for (const name of ["localhost", "127.0.0.1", "::1"]) allowedOrigins.add(originOf(scheme, name, port));
  if (dev) allowedOrigins.add(VITE_DEV_ORIGIN);
  const script = input.env.PAP_TEST_PROVIDER_SCRIPT;
  if (script !== undefined && !isAbsolute(script))
    throw new ConfigError("PAP_TEST_PROVIDER_SCRIPT must be an absolute path");
  const workerImport = input.env.PAP_TEST_WORKER_IMPORT;
  if (workerImport !== undefined && !isAbsolute(workerImport))
    throw new ConfigError("PAP_TEST_WORKER_IMPORT must be an absolute path");
  const gitProtocols = input.env.PAP_TEST_GIT_PROTOCOLS;
  if (gitProtocols !== undefined && script === undefined)
    throw new ConfigError("PAP_TEST_GIT_PROTOCOLS needs PAP_TEST_PROVIDER_SCRIPT");
  if (gitProtocols !== undefined && !/^(?:file|https|ssh)(?::(?:file|https|ssh))*$/.test(gitProtocols))
    throw new ConfigError("PAP_TEST_GIT_PROTOCOLS must list file, https or ssh");
  return {
    home: devId
      ? directoryFrom(input.env.PAP_HOME, "PAP_HOME", input.homedir, join(input.homedir, ".pap-dev", devId))
      : homeFrom(input.env, input.homedir),
    host,
    port,
    dev,
    tls,
    insecureHttp,
    publicOrigin,
    allowedOrigins,
    piAgentDir: directoryFrom(
      input.env.PI_CODING_AGENT_DIR,
      "PI_CODING_AGENT_DIR",
      input.homedir,
      join(input.homedir, ".pi", "agent"),
    ),
    userHome: input.homedir,
    piHostEntry: input.piHostEntry,
    // Test-only, like the scripted provider it rides with: a preload (the network guard) for every worker. Absolute,
    // because a worker's cwd is the session's project.
    piHostExecArgv:
      workerImport !== undefined && script !== undefined
        ? [...input.piHostExecArgv, `--import=${workerImport}`]
        : input.piHostExecArgv,
    testProviderScript: script ?? null,
    testGitProtocols: gitProtocols ?? null,
    testOutboxHold: parseOutboxHold(
      input.env.PAP_TEST_OUTBOX_HOLD,
      script !== undefined,
      (message) => new ConfigError(message),
    ),
    maxWorkers: input.env.PAP_MAX_WORKERS
      ? parseCount(input.env.PAP_MAX_WORKERS, "PAP_MAX_WORKERS", 1)
      : defaultMaxWorkers(input.totalMemMb),
    minFreeMemMb: input.env.PAP_MIN_FREE_MEM_MB
      ? parseCount(input.env.PAP_MIN_FREE_MEM_MB, "PAP_MIN_FREE_MEM_MB", 0)
      : DEFAULT_MIN_FREE_MEM_MB,
    minFreeDiskMb: input.env.PAP_MIN_FREE_DISK_MB
      ? parseCount(input.env.PAP_MIN_FREE_DISK_MB, "PAP_MIN_FREE_DISK_MB", 0)
      : 1024,
    maxTerminals: input.env.PAP_MAX_TERMINALS
      ? parseCount(input.env.PAP_MAX_TERMINALS, "PAP_MAX_TERMINALS", 1, MAX_TERMINALS_LIMIT)
      : DEFAULT_MAX_TERMINALS,
    workerIdleMs:
      (input.env.PAP_WORKER_IDLE_MINUTES
        ? parseCount(input.env.PAP_WORKER_IDLE_MINUTES, "PAP_WORKER_IDLE_MINUTES", 0, MAX_IDLE_MINUTES)
        : 30) * 60_000,
    workerScope: parseScope(input.env.PAP_WORKER_SCOPE),
    workerLimits: {
      memoryMaxMb: input.env.PAP_WORKER_MEMORY_MAX_MB
        ? parseCount(input.env.PAP_WORKER_MEMORY_MAX_MB, "PAP_WORKER_MEMORY_MAX_MB", 1024)
        : defaultMemoryMaxMb(input.totalMemMb),
      tasksMax: input.env.PAP_WORKER_TASKS_MAX
        ? parseCount(input.env.PAP_WORKER_TASKS_MAX, "PAP_WORKER_TASKS_MAX", 64)
        : 4096,
    },
    helpersMax: input.env.PAP_HELPERS_MAX
      ? parseCount(input.env.PAP_HELPERS_MAX, "PAP_HELPERS_MAX", 1, 16)
      : 4,
    metricsToken: parseMetricsToken(input.env.PAP_METRICS_TOKEN),
    otlp: parseOtlp(input.env, (message) => new ConfigError(message)),
    ...parsePush(input.env, script !== undefined, (message) => new ConfigError(message)),
    bwrapOverride: parseBwrap(input.env.PAP_BWRAP),
    staticRoot: input.staticRoot,
    logLevel: parseLevel(input.env.PAP_LOG_LEVEL),
  };
}

/** `$PAP_HOME`, or `~/.pap`: what `pap serve` and every CLI admin command open. */
export function homeFrom(env: NodeJS.ProcessEnv, homedir: string): string {
  return directoryFrom(env.PAP_HOME, "PAP_HOME", homedir, join(homedir, ".pap"));
}

// Empty means unset and a leading ~ expands, exactly as Pi's getAgentDir() does, so pap and Pi always
// agree on the directory they share. A relative path would land wherever the process was started.
function directoryFrom(raw: string | undefined, name: string, homedir: string, fallback: string): string {
  if (raw === undefined || raw === "") return fallback;
  const expanded = raw === "~" ? homedir : raw.startsWith("~/") ? join(homedir, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new ConfigError(`${name} must be an absolute path`);
  return expanded;
}

// Read once, here: a missing or damaged file is an operator's typo and gets one line naming the flag. Left to the
// HTTPS server it would be a stack trace from deep inside start-up. Only the errno code is kept, never the path.
function readTls(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
  const read = (path: string, flag: string): Buffer => {
    try {
      return readFileSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      throw new ConfigError(`${flag} cannot be read (${code})`);
    }
  };
  const cert = read(certPath, "--tls-cert");
  const key = read(keyPath, "--tls-key");
  // The TLS stack's own parser decides, so what it would refuse at listen time is refused here, with the flag named:
  // each file alone (PEM only, no passphrase), then the pair.
  const accepts = (options: { cert?: Buffer; key?: Buffer }): boolean => {
    try {
      createSecureContext(options);
      return true;
    } catch {
      return false;
    }
  };
  if (!accepts({ cert })) throw new ConfigError("--tls-cert is not a certificate in PEM format");
  if (!accepts({ key })) throw new ConfigError("--tls-key is not an unencrypted private key in PEM format");
  if (!accepts({ cert, key })) throw new ConfigError("--tls-key does not match --tls-cert");
  return { cert, key };
}

const HOST_ERROR = "--host must be a host name or an IP address";

// The returned host is what the listener binds, so an empty one (which Node reads as "all interfaces")
// is refused: exposing every interface takes an explicit 0.0.0.0 or ::. IPv6 comes back without brackets.
function parseHost(raw: string): string {
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (bare === "" || BAD_HOST_CHARS.test(bare)) throw new ConfigError(HOST_ERROR);
  try {
    return new URL(`http://${bracketed(bare)}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new ConfigError(HOST_ERROR);
  }
}

const bracketed = (host: string): string => (host.includes(":") ? `[${host}]` : host);

const originOf = (scheme: string, host: string, port: number): string =>
  new URL(`${scheme}://${bracketed(host)}:${port}`).origin;

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        dev: { type: "boolean", default: false },
        host: { type: "string" },
        port: { type: "string" },
        "tls-cert": { type: "string" },
        "tls-key": { type: "string" },
        "insecure-http": { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    // Node's own message quotes the offending argument; only its stable code is kept.
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
    throw new ConfigError(`invalid command-line arguments (${code})`);
  }
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigError("--port must be an integer from 1 to 65535");
  return port;
}

function parseCount(raw: string, name: string, min: number, max?: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${name} must be an integer ≥ ${min}`);
  if (max !== undefined && value > max) throw new ConfigError(`${name} must be an integer ≤ ${max}`);
  return value;
}

// url.origin drops any user:password@ part, so credentials typed into PAP_PUBLIC_ORIGIN never reach Config.
function parseOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.origin === "null") throw new Error("opaque origin");
    return url.origin;
  } catch {
    throw new ConfigError("PAP_PUBLIC_ORIGIN must be an origin such as https://pap.example.net");
  }
}

function parseLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return "info";
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new ConfigError("PAP_LOG_LEVEL must be debug, info, warn or error");
}

function parseScope(raw: string | undefined): "auto" | "off" {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "off") return "off";
  throw new ConfigError("PAP_WORKER_SCOPE must be auto or off");
}

function parseMetricsToken(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!METRICS_TOKEN.test(raw))
    throw new ConfigError("PAP_METRICS_TOKEN must be 32 to 256 characters of A-Z a-z 0-9 . _ ~ + / = -");
  return raw;
}

function parseBwrap(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!isAbsolute(raw)) throw new ConfigError("PAP_BWRAP must be an absolute path");
  return raw;
}
