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

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = serve({
    fetch: options.app.fetch,
    hostname: options.host,
    port: options.port,
    ...(options.tls
      ? {
          createServer: createHttpsServer,
          serverOptions: { cert: options.tls.cert, key: options.tls.key },
        }
      : {}),
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
