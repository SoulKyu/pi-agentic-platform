import type { IncomingMessage, Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly cert: Buffer; readonly key: Buffer } | null;
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * An 'error' the listening server raises later (accept failing on EMFILE, say). Node throws such an error as an
   * uncaught exception when nobody listens, so a listener stays for the server's whole life (R75).
   */
  onError(error: NodeJS.ErrnoException): void;
}

/**
 * How long a request may take from its first byte to its last (M8R106). Node's own default, written down: an upload of
 * 25 MiB must finish within 5 minutes, about 700 kbit/s. A slower link is cut off and the client is told to retry.
 */
export const UPLOAD_REQUEST_TIMEOUT_MS = 300_000;

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = serve({
    fetch: options.app.fetch,
    hostname: options.host,
    port: options.port,
    serverOptions: { requestTimeout: UPLOAD_REQUEST_TIMEOUT_MS, ...(options.tls ?? {}) },
    ...(options.tls ? { createServer: createHttpsServer } : {}),
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
  server.on("upgrade", options.onUpgrade);
  server.on("error", options.onError);
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
