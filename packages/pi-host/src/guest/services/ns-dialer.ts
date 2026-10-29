import net from "node:net";

/**
 * The namespace helper's own program (spec §5): the guest starts it with `nsenter --net=/proc/self/fd/4` inside a
 * service's network namespace and nothing else, so it shares that loopback and no other namespace. For each request it
 * connects to the service's port on loopback and hands the connected socket back over the IPC channel, then forgets it.
 * It reads no byte of the connection (HTTP speaks first from the client). Anything that is not a well-formed request is ignored.
 */
/** Matches `NS_DIAL_MS` in ns-dial.ts (the helper imports nothing of the guest). */
const DIAL_MS = 5_000;
const HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

process.on("message", (raw: unknown) => {
  if (typeof raw !== "object" || raw === null) return;
  const { id, host, port } = raw as { id?: unknown; host?: unknown; port?: unknown };
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
  if (typeof host !== "string" || !HOSTS.has(host)) return;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65_535) return;
  const socket = net.connect({ host, port });
  // The guest gives up on a dial after NS_DIAL_MS (ns-dial.ts): the helper does not outlast it.
  socket.setTimeout(DIAL_MS, () => socket.destroy(new Error("timeout")));
  socket.once("connect", () => {
    socket.setTimeout(0);
    process.send?.({ id, ok: true }, socket);
  });
  socket.once("error", () => {
    socket.destroy();
    process.send?.({ id, ok: false });
  });
});
// The guest is gone or closed the channel: the helper has nothing left to do.
process.on("disconnect", () => process.exit(0));
