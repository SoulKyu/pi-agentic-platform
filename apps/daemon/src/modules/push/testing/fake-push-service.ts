import { createECDH, randomBytes, type ECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscriptionInput } from "@pap/contracts";
import { selfSignedCertificate } from "../../../testing/self-signed.ts";
import type { SubscriptionTarget } from "../index.ts";

export interface RecordedRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface FakePushService {
  /** `http://127.0.0.1:<port>` (or `https://`): only for the fenced loopback switch or an injected `allowAddress`. */
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** TCP connections accepted so far, a TLS handshake that failed included. */
  connections(): number;
  /** Response bytes the service managed to hand to the socket (a client that hangs up early stops it). */
  bytesSent(): number;
  /** The next request is answered with this; later ones get 201. */
  respondNext(status: number, headers?: Record<string, string>, body?: string): void;
  /** The next request is answered with this many bytes of 'x', in chunks, stopping when the client goes away. */
  respondBigNext(status: number, totalBytes: number): void;
  /** The next request is read and then never answered. */
  hangNext(): void;
  /** Resolves once `count` requests have been fully received. */
  received(count: number): Promise<void>;
  /** Resolves when every request seen so far has ended or been cut. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

type Plan =
  | { kind: "reply"; status: number; headers: Record<string, string>; body: string }
  | { kind: "big"; status: number; total: number }
  | { kind: "hang" };

const CHUNK = 64 * 1024;

/** A local push service: records what arrives and answers as the test says. No network beyond 127.0.0.1. */
export async function startFakePushService(options: { tls?: boolean } = {}): Promise<FakePushService> {
  const requests: RecordedRequest[] = [];
  const plans: Plan[] = [];
  let connections = 0;
  let sent = 0;
  let open = 0;
  let waiters: Array<() => void> = [];
  let arrivals: Array<() => void> = [];
  const noteClosed = () => {
    open -= 1;
    if (open === 0) {
      const ready = waiters;
      waiters = [];
      for (const wake of ready) wake();
    }
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    open += 1;
    res.on("close", noteClosed);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("end", () => {
      queueMicrotask(() => arrivals.forEach((check) => check()));
      requests.push({
        path: req.url ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, [value ?? ""].flat().join(", ")]),
        ),
        body: Buffer.concat(chunks),
      });
      const plan = plans.shift() ?? { kind: "reply", status: 201, headers: {}, body: "" };
      if (plan.kind === "hang") return;
      if (plan.kind === "reply") {
        res.writeHead(plan.status, plan.headers);
        res.end(plan.body);
        return;
      }
      res.writeHead(plan.status, { "content-type": "text/plain" });
      let left = plan.total;
      const pump = () => {
        while (left > 0 && !res.destroyed) {
          const size = Math.min(CHUNK, left);
          left -= size;
          sent += size;
          if (!res.write(Buffer.alloc(size, 0x78))) return void res.once("drain", pump);
        }
        if (!res.destroyed) res.end();
      };
      pump();
    });
  }

  let dir: string | null = null;
  let server: Server;
  if (options.tls) {
    dir = mkdtempSync(join(tmpdir(), "pap-fake-push-"));
    const files = selfSignedCertificate(dir);
    server = createTlsServer({ cert: readFileSync(files.cert), key: readFileSync(files.key) }, handle);
  } else {
    server = createServer(handle);
  }
  server.on("connection", () => void (connections += 1));
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    requests,
    connections: () => connections,
    bytesSent: () => sent,
    respondNext: (status, headers = {}, body = "") =>
      void plans.push({ kind: "reply", status, headers, body }),
    respondBigNext: (status, total) => void plans.push({ kind: "big", status, total }),
    hangNext: () => void plans.push({ kind: "hang" }),
    received: (count) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (requests.length >= count) {
            arrivals = arrivals.filter((entry) => entry !== check);
            resolve();
          }
        };
        arrivals.push(check);
        check();
      }),
    settled: () => (open === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestBrowser {
  readonly ecdh: ECDH;
  readonly p256dh: string;
  readonly auth: string;
  readonly authSecret: Buffer;
  input(endpoint: string): PushSubscriptionInput;
  target(endpoint: string): SubscriptionTarget;
}

/** A browser's side of a subscription, with the private key kept so a test can open what the sender sealed. */
export function createTestBrowser(): TestBrowser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const p256dh = ecdh.getPublicKey().toString("base64url");
  const auth = authSecret.toString("base64url");
  return {
    ecdh,
    p256dh,
    auth,
    authSecret,
    input: (endpoint) => ({ endpoint, keys: { p256dh, auth }, locale: "en", label: "Test browser" }),
    target: (endpoint) => ({
      id: "sub-1",
      endpoint,
      p256dh,
      auth,
      credentialId: "cred-1",
      locale: "en",
    }),
  };
}
