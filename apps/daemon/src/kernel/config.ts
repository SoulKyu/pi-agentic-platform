import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { LogLevel } from "./logger.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const DEFAULT_MIN_FREE_MEM_MB = 512;
export const VITE_DEV_ORIGIN = "http://localhost:5173";
// Measured in docs/spikes/s4.md: idle worker ≈156 MB RSS / ≈103 MB PSS; ceil(157 × 1.5).
export const WORKER_BUDGET_MB = 236;

// Messages are fixed text: no flag value, environment value or path is ever echoed (spec C §4.1),
// so a mistyped secret cannot reach a terminal, a log line or a crash report through a config error.
export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly dev: boolean;
  /** The certificate and key as read at start-up (PEM); the server never reads the files again. */
  readonly tls: { readonly cert: Buffer; readonly key: Buffer } | null;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly piAgentDir: string;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly testProviderScript: string | null;
  readonly maxWorkers: number;
  readonly minFreeMemMb: number;
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
 * The node flags that shape how modules load carry over from the daemon to every worker it forks: the development
 * condition (`--conditions=development`, so a worker finds the TypeScript sources too) and preloads written as
 * `--import=<file>` (instrumentation, the test network guard). Nothing else is forwarded.
 */
export function workerExecArgv(execArgv: readonly string[]): string[] {
  return execArgv.filter((arg) => arg.startsWith("--conditions") || arg.startsWith("--import="));
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
  return {
    home: directoryFrom(
      input.env.PAP_HOME,
      "PAP_HOME",
      input.homedir,
      devId ? join(input.homedir, ".pap-dev", devId) : join(input.homedir, ".pap"),
    ),
    host,
    port,
    dev,
    tls,
    publicOrigin,
    allowedOrigins,
    piAgentDir: directoryFrom(
      input.env.PI_CODING_AGENT_DIR,
      "PI_CODING_AGENT_DIR",
      input.homedir,
      join(input.homedir, ".pi", "agent"),
    ),
    piHostEntry: input.piHostEntry,
    piHostExecArgv: input.piHostExecArgv,
    testProviderScript: script ?? null,
    maxWorkers: input.env.PAP_MAX_WORKERS
      ? parseCount(input.env.PAP_MAX_WORKERS, "PAP_MAX_WORKERS", 1)
      : defaultMaxWorkers(input.totalMemMb),
    minFreeMemMb: input.env.PAP_MIN_FREE_MEM_MB
      ? parseCount(input.env.PAP_MIN_FREE_MEM_MB, "PAP_MIN_FREE_MEM_MB", 0)
      : DEFAULT_MIN_FREE_MEM_MB,
    staticRoot: input.staticRoot,
    logLevel: parseLevel(input.env.PAP_LOG_LEVEL),
  };
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
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert);
  } catch {
    throw new ConfigError("--tls-cert is not a certificate in PEM format");
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key });
  } catch {
    throw new ConfigError("--tls-key is not an unencrypted private key in PEM format");
  }
  if (!certificate.checkPrivateKey(privateKey)) throw new ConfigError("--tls-key does not match --tls-cert");
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

function parseCount(raw: string, name: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${name} must be an integer ≥ ${min}`);
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
