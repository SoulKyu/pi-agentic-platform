import net from "node:net";

export const blockedAttempts: string[] = [];
const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  const unixSocket = typeof first === "string" || (typeof first === "object" && first !== null && "path" in first);
  if (unixSocket) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  blockedAttempts.push(JSON.stringify(first));
  process.stderr.write(`pap-network-guard: blocked ${JSON.stringify(first)}\n`);
  throw new Error("network access is disabled in this process");
} as typeof originalConnect;
