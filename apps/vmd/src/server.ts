import { chmodSync, chownSync, lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import { VMD_MAX_FRAME_BYTES, VmdRequest } from "@pap/contracts";
import type { Clock, TimerHandle } from "./clock.ts";
import { VmdFailure, type VmdCode, type VmdResponseBody } from "./errors.ts";
import type { Logger } from "./log.ts";

/** A request that has not arrived whole in this long is refused. */
export const REQUEST_READ_MS = 10_000;
/** After a refusal the rest of the request is discarded for this long, then the connection is dropped. */
const LINGER_MS = 2_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const NEWLINE = 0x0a;

export interface VmdServerDeps {
  /** `/run/pap-vm/vmd.sock` */
  readonly socketPath: string;
  /** The uid and gid `/etc/pap-vm/config.json` names (R36). */
  readonly papUid: number;
  readonly papGid: number;
  /** T13b's dispatch of one validated request; a thrown `VmdFailure` is its typed answer. */
  readonly handle: (request: VmdRequest) => Promise<unknown>;
  readonly log: Logger;
  readonly clock: Clock;
  readonly maxConnections?: number;
  /** Test seam; default `fs.chownSync`. */
  readonly chown?: (file: string, uid: number, gid: number) => void;
}

export interface VmdServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * RT-33, R36: one typed JSON request per connection on a unix socket owned by pap's uid, mode 0600. The request is UTF-8
 * JSON ended by a newline or by the client closing its writing side; it is at most `VMD_MAX_FRAME_BYTES` and is never
 * parsed once it is over. It must pass `VmdRequest` before anything runs. The answer is one `VmdResponse` line (also at most
 * that size), then the connection is closed. A log record names the op, agent, task key, result and duration, never the request.
 */
export function createVmdServer(deps: VmdServerDeps): VmdServer {
  const { socketPath, handle, log, clock } = deps;
  const maxConnections = deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const chown = deps.chown ?? chownSync;
  const open = new Set<net.Socket>();
  let bound = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const server = net.createServer({ allowHalfOpen: true }, onConnection);

  function encode(response: VmdResponseBody): Buffer {
    let text: string;
    try {
      text = JSON.stringify(response);
    } catch {
      text = "";
    }
    if (text === "" || Buffer.byteLength(text) > VMD_MAX_FRAME_BYTES)
      text = JSON.stringify({ ok: false, code: "failed" });
    return Buffer.from(`${text}\n`);
  }

  /** `draining`: part of the request is unread, so reading goes on (and is discarded) until the client is done. */
  function reply(socket: net.Socket, response: VmdResponseBody, draining: boolean): void {
    if (socket.destroyed) return;
    if (!draining) {
      socket.end(encode(response), () => socket.destroy());
      return;
    }
    socket.end(encode(response));
    socket.resume();
    const linger = clock.setTimeout(() => socket.destroy(), LINGER_MS);
    socket.once("close", () => clock.clearTimeout(linger));
  }

  const refuse = (code: VmdCode): VmdResponseBody => ({ ok: false, code });

  function record(
    op: string | null,
    agentId: string | null,
    taskKey: string | null,
    result: string,
    since: number,
  ): void {
    log.info("vmd_call", { op, agentId, taskKey, result, ms: clock.now() - since });
  }

  async function serve(bytes: Buffer, since: number): Promise<VmdResponseBody> {
    let request: VmdRequest;
    try {
      request = VmdRequest.parse(JSON.parse(decoder.decode(bytes)));
    } catch {
      record(null, null, null, "bad_request", since);
      return refuse("bad_request");
    }
    const agentId = "agentId" in request ? request.agentId : null;
    const taskKey = "taskKey" in request ? request.taskKey : null;
    try {
      const result = await handle(request);
      record(request.op, agentId, taskKey, "ok", since);
      return { ok: true, result };
    } catch (error) {
      const code = error instanceof VmdFailure ? error.code : "failed";
      record(request.op, agentId, taskKey, code, since);
      return refuse(code);
    }
  }

  function onConnection(socket: net.Socket): void {
    // Once, at accept, for every path (capacity, oversize, timeout, normal reply): a socket error never escapes.
    socket.on("error", () => socket.destroy());
    const since = clock.now();
    if (open.size >= maxConnections) {
      record(null, null, null, "capacity", since);
      reply(socket, refuse("capacity"), true);
      return;
    }
    open.add(socket);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let deadline: TimerHandle | null = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      deadline = null;
      record(null, null, null, "bad_request", since);
      reply(socket, refuse("bad_request"), true);
    }, REQUEST_READ_MS);
    const stopTimer = (): void => {
      if (deadline !== null) clock.clearTimeout(deadline);
      deadline = null;
    };
    const complete = (): void => {
      settled = true;
      stopTimer();
      serve(Buffer.concat(chunks), since).then(
        (response) => reply(socket, response, false),
        () => reply(socket, refuse("failed"), false),
      );
    };
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      const newline = chunk.indexOf(NEWLINE);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > VMD_MAX_FRAME_BYTES) {
        settled = true;
        stopTimer();
        chunks.length = 0;
        record(null, null, null, "bad_request", since);
        reply(socket, refuse("bad_request"), true);
        return;
      }
      chunks.push(part);
      if (newline !== -1) complete();
    });
    socket.on("end", () => {
      if (!settled) complete();
    });
    socket.on("close", () => {
      settled = true;
      stopTimer();
      open.delete(socket);
    });
  }

  function clearStaleSocket(): void {
    let stat;
    try {
      stat = lstatSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isSocket()) throw new Error(`vmd: ${socketPath} exists and is not a socket`);
    unlinkSync(socketPath);
  }

  return {
    async listen() {
      clearStaleSocket();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          // A later accept error (EMFILE, ENOMEM) must be logged, not thrown: an uncaught 'error' would stop the root process.
          server.on("error", (error: NodeJS.ErrnoException) =>
            log.info("vmd_server_error", { code: error.code ?? null }),
          );
          bound = true;
          resolve();
        });
      });
      try {
        // Until here the socket answers only root when the umask strips group and other write (a socket needs write permission to be connected to).
        chmodSync(socketPath, 0o600);
        chown(socketPath, deps.papUid, deps.papGid);
      } catch (error) {
        await this.close();
        throw error;
      }
    },
    async close() {
      for (const socket of open) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!bound) return;
      bound = false;
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone (net unlinks the path it bound on close).
      }
    },
  };
}
