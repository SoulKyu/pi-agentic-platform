import type { ParsedUnit } from "../service/unit-read.ts";

/** What `pushReadiness` (kernel/push-readiness.ts, M12) reads: where pap says it is reached, and how it listens. */
export interface ListenFacts {
  readonly publicOrigin: string;
  readonly tls: boolean;
  readonly insecureHttp: boolean;
  /** `--preview-port`, else `PAP_PREVIEW_PORT`, else the app's port + 1 (`parsePreview`). */
  readonly previewPort: number;
}

// The defaults and rules below are the ones of `loadConfig` (kernel/config.ts), which doctor must not import for its side
// effects (it reads the certificate files). listen-facts.test.ts compares both on the same argv and environment.
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;

const bracketed = (host: string): string => (host.includes(":") ? `[${host}]` : host);
const isLoopbackOrWildcard = (host: string): boolean =>
  ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host);

/** `parseHost`: the host the listener binds, IPv6 without brackets, lowercased by the URL parser. */
function hostOf(raw: string | null): string {
  if (raw === null) return DEFAULT_HOST;
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  try {
    return new URL(`http://${bracketed(bare)}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return DEFAULT_HOST;
  }
}

/** `parseOrigin`: credentials and path dropped; null for what the daemon would refuse to start with. */
function originOf(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    const { origin } = new URL(raw);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The host a probe of the daemon's own listeners connects to: loopback for a loopback or wildcard bind, else the bind address. */
export function probeHostOf(unit: ParsedUnit | null): string {
  const host = hostOf(unit?.host ?? null);
  return isLoopbackOrWildcard(host) ? DEFAULT_HOST : host;
}

/** `parsePreview`'s port rule for a unit; what the daemon would refuse falls back to the default. */
function previewPortOf(unit: ParsedUnit | null, env: NodeJS.ProcessEnv, port: number): number {
  if (unit?.previewPort != null) return unit.previewPort;
  const raw = (unit === null ? env : unit.env).PAP_PREVIEW_PORT;
  const set = raw !== undefined && /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  return set >= 1 && set <= 65_535 && set !== port ? set : port + 1;
}

/**
 * Where the daemon of `unit` says it is reached. `PAP_PUBLIC_ORIGIN` comes from the unit's environment (the shell's only when
 * no unit is installed, as the daemon never sees the shell's); else `scheme://host:port`, with `localhost` for a loopback or
 * wildcard `--host`. Pure: no file is read, and an origin the daemon would refuse falls back to the listen address.
 */
export function listenFacts(unit: ParsedUnit | null, env: NodeJS.ProcessEnv): ListenFacts {
  const host = hostOf(unit?.host ?? null);
  const port = unit?.port ?? DEFAULT_PORT;
  const tls = unit?.tls ?? false;
  const scheme = tls ? "https" : "http";
  const listen = new URL(`${scheme}://${bracketed(isLoopbackOrWildcard(host) ? "localhost" : host)}:${port}`)
    .origin;
  return {
    publicOrigin: originOf((unit === null ? env : unit.env).PAP_PUBLIC_ORIGIN) ?? listen,
    tls,
    insecureHttp: unit?.insecureHttp ?? false,
    previewPort: previewPortOf(unit, env, port),
  };
}
