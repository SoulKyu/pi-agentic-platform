import { safePath, UnitInputError } from "./unit.ts";

export interface ParsedUnit {
  readonly node: string;
  readonly main: string;
  readonly port: number | null;
  readonly host: string | null;
  readonly home: string | null;
  readonly env: Record<string, string>;
  readonly tls: boolean;
  readonly insecureHttp: boolean;
}

const HOST = /^[A-Za-z0-9._:[\]-]{1,255}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_VALUE = /^[^\s"'$%\\;]{0,4096}$/;

function safe(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return safePath("unit", value);
  } catch (error) {
    if (error instanceof UnitInputError) return null;
    throw error;
  }
}

/** `--name value` or `--name=value`, from the tokens after `serve`. */
function flagValue(args: readonly string[], name: string): { found: boolean; value: string | null } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === name) return { found: true, value: args[i + 1] ?? null };
    if (arg.startsWith(`${name}=`)) return { found: true, value: arg.slice(name.length + 1) };
  }
  return { found: false, value: null };
}

/**
 * Reads the effective unit text (`systemctl cat`, drop-ins included) back into what `renderUnit` wrote. systemd rules: an
 * empty `ExecStart=` or `Environment=` resets what came before, the last `ExecStart=` wins, `Environment=` lines merge in
 * order. Null when the shape is not ours: no `ExecStart`, a node or script path outside `safePath`, no `serve`, a bad
 * port, host or TLS path. The caller treats null as "a hand-edited unit": it refuses with a fixed sentence.
 */
export function parseUnit(text: string): ParsedUnit | null {
  let exec: string | null = null;
  let env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    // an environment file can set PAP_HOME where this reader cannot see it
    if (/^EnvironmentFile\s*=\s*\S/.test(line)) return null;
    if (line.startsWith("ExecStart=")) exec = line.slice("ExecStart=".length).trim() || null;
    else if (line.startsWith("Environment=")) {
      const body = line.slice("Environment=".length).trim();
      if (body === "") env = {};
      for (const assignment of body === "" ? [] : body.split(/\s+/)) {
        const at = assignment.indexOf("=");
        const name = assignment.slice(0, at);
        const value = assignment.slice(at + 1);
        // an assignment this reader cannot read (quotes, escapes, a lookalike of PAP_HOME) makes the whole unit unreadable
        if (at <= 0 || !ENV_NAME.test(name) || !ENV_VALUE.test(value)) return null;
        env[name] = value;
      }
    }
  }
  if (exec === null || env.PAP_HOME === "") return null;
  const tokens = exec.split(/\s+/);
  const node = safe(tokens[0]);
  let at = 1;
  while ((tokens[at] ?? "").startsWith("--") && tokens[at] !== "serve") at++;
  const main = safe(tokens[at]);
  if (node === null || main === null || tokens[at + 1] !== "serve") return null;
  const args = tokens.slice(at + 2);

  const portFlag = flagValue(args, "--port");
  const port = portFlag.value === null ? null : Number(portFlag.value);
  if (
    portFlag.found &&
    !(port !== null && /^\d{1,5}$/.test(portFlag.value ?? "") && port >= 1 && port <= 65_535)
  )
    return null;
  const hostFlag = flagValue(args, "--host");
  if (hostFlag.found && (hostFlag.value === null || !HOST.test(hostFlag.value))) return null;
  for (const name of ["--tls-cert", "--tls-key"]) {
    const flag = flagValue(args, name);
    if (flag.found && safe(flag.value ?? undefined) === null) return null;
  }
  return {
    node,
    main,
    port,
    host: hostFlag.value,
    home: env.PAP_HOME ?? null,
    env,
    tls: flagValue(args, "--tls-cert").found,
    insecureHttp: args.includes("--insecure-http"),
  };
}
