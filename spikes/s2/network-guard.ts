import net from "node:net";

// Same rule as packages/pi-host/src/testing/network-guard.ts (R94): only a unix socket with a real path connects;
// `path: undefined` or `path: ""` is how TLS and HTTP clients say "no unix socket", and the args may be the
// normalized `[options, callback]` array.
export const blockedAttempts: string[] = [];
const originalConnect = net.Socket.prototype.connect;

function isUnixSocket(options: unknown): boolean {
  if (typeof options === "string") return options !== "" && !/^\d+$/.test(options);
  if (typeof options !== "object" || options === null) return false;
  const { path } = options as { path?: unknown };
  return typeof path === "string" && path !== "";
}

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  if (isUnixSocket(options)) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  blockedAttempts.push(JSON.stringify(options));
  process.stderr.write(`pap-network-guard: blocked ${JSON.stringify(options)}\n`);
  throw new Error("network access is disabled in this process");
} as typeof originalConnect;
