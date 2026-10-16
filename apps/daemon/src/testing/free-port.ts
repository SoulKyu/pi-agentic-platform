import { createServer } from "node:net";

// Below Linux's default ephemeral range (32768-60999): the kernel hands a port it just released to the next
// `listen(0)` or outgoing connection of any process, so a port found there and closed is gone before the caller binds it
// when several test runs share the host. 30141 is pi-web; 7777 is outside the range.
const LOW = 20_000;
const HIGH = 29_999;
const RESERVED = new Set([30_141, 7_777]);
const handedOut = new Set<number>();

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A port nobody listens on, outside the ephemeral range and never given twice by this process. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW + 1));
    if (RESERVED.has(port) || handedOut.has(port)) continue;
    handedOut.add(port);
    if (await canBind(port)) return port;
  }
  throw new Error(`no free port found in ${LOW}-${HIGH}`);
}
