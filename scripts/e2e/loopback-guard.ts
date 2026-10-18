// The daemon's network guard (packages/pi-host/src/testing/network-guard.ts, refuses every TCP connect) with one exception
// for J13: a connect to 127.0.0.1. The daemon's push sender must reach the sink of the journey, which listens there; with
// PAP_TEST_PUSH_LOOPBACK=1 the daemon accepts such an endpoint and nothing else (daemon.ts uses this file only then).
// Plain TypeScript with node:net only, loaded with --import; no `@pap/*` import.
import net from "node:net";

const original = net.Socket.prototype.connect;
await import("../../packages/pi-host/src/testing/network-guard.ts");
const guarded = net.Socket.prototype.connect;

function isLoopback(args: unknown[]): boolean {
  const first = args[0];
  const options: unknown = Array.isArray(first) ? first[0] : first;
  if (typeof options !== "object" || options === null) return false;
  // An HTTP request hands net the URL's `hostname` and no `host` (the sender's request does).
  const { host, hostname, path } = options as { host?: unknown; hostname?: unknown; path?: unknown };
  return (host ?? hostname) === "127.0.0.1" && (path === undefined || path === null || path === "");
}

net.Socket.prototype.connect = function loopbackConnect(this: net.Socket, ...args: unknown[]) {
  const connect = isLoopback(args) ? original : guarded;
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof original;
