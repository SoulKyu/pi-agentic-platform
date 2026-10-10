import { readFileSync } from "node:fs";
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
  readonly tls: { readonly cert: string; readonly key: string } | null;
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = serve({
    fetch: options.app.fetch,
    hostname: options.host,
    port: options.port,
    ...(options.tls
      ? {
          createServer: createHttpsServer,
          serverOptions: { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) },
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
