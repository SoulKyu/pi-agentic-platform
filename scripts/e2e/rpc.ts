// One RPC over the daemon's websocket (spec C 4.2): open `/ws?proto=2`, read the hello frame, send
// `{id, method, params, commandId}`, resolve on the frame that carries the same `id`. A commandId on a read method is ignored.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const RPC_MS = 15_000;

export async function rpcCall<T>(
  origin: string,
  cookie: string,
  method: string,
  params: object = {},
  timeoutMs = RPC_MS,
): Promise<T> {
  const url = `${origin.replace("//localhost:", "//127.0.0.1:").replace(/^http/, "ws")}/ws?proto=2`;
  const socket = new WebSocket(url, { headers: { origin, cookie: `pap_session=${cookie}` } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
      let greeted = false;
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`/ws answered ${res.statusCode}`)));
      socket.on("close", (code) =>
        reject(new Error(`the socket closed (${code}) before the answer to ${method}`)),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (!greeted) {
          greeted = true;
          socket.send(JSON.stringify({ id: 1, method, params, commandId: randomUUID() }));
          return;
        }
        if (frame["id"] !== 1) return;
        if (frame["ok"] === true) resolve(frame["result"] as T);
        else reject(new Error(`${method} failed: ${JSON.stringify(frame["error"] ?? frame)}`));
      });
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
