import net from "node:net";

/** The connect options of every attempt the guard refused, as JSON. In-process tests assert it stays empty. */
export const blockedAttempts: string[] = [];

const originalConnect = net.Socket.prototype.connect;

// Node hands connect() either the caller's arguments or the already normalized `[options, callback]` array that
// net.connect, tls.connect and every HTTP client build.
function optionsOf(args: unknown[]): unknown {
  const first = args[0];
  return Array.isArray(first) ? first[0] : first;
}

// Only a unix socket may connect. A `path` key that is undefined or empty is how TLS and HTTP clients say "no unix
// socket", so the key alone proves nothing: it must hold a real path. A bare string is a path unless it reads as a
// port number, the way net.connect parses it.
function isUnixSocket(options: unknown): boolean {
  if (typeof options === "string") return options !== "" && !/^\d+$/.test(options);
  if (typeof options !== "object" || options === null) return false;
  const { path } = options as { path?: unknown };
  return typeof path === "string" && path !== "";
}

function describe(options: unknown): string {
  try {
    return JSON.stringify(options) ?? String(options);
  } catch {
    return String(options);
  }
}

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const options = optionsOf(args);
  if (isUnixSocket(options)) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  const description = describe(options);
  blockedAttempts.push(description);
  process.stderr.write(`pap-network-guard: blocked ${description}\n`);
  throw new Error("network access is disabled in tests");
} as typeof originalConnect;
