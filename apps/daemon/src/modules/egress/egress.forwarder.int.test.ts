import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import { createServer as createHttpServer } from "node:http";
import { EGRESS_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { freePort } from "../../testing/free-port.ts";
import { selfSignedCertificate } from "../../testing/self-signed.ts";
import { FORWARDER_SOURCE } from "./forwarder.ts";
import { type CommandListener, createProxy, type Limits } from "./index.ts";
import { scopeOf } from "./testing/bed.ts";
import { loopbackBed } from "./testing/loopback.ts";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
if (!hasPython)
  console.warn("egress.forwarder.int.test.ts: python3 not found, the forwarder cases are skipped");

let tmp: string;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fwd-"));
});
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
  rmSync(tmp, { recursive: true, force: true });
});

it.runIf(!hasPython && Boolean(process.env["CI"]))("python3 is required under CI", () => {
  throw new Error("python3 is missing: the forwarder cannot be tested");
});

interface Rig {
  port: number;
  forwarder: ChildProcess;
  exited: Promise<number | null>;
  listener: CommandListener;
  cert: string;
}

async function rig(limits: Limits = EGRESS_LIMITS): Promise<Rig> {
  const certs = selfSignedCertificate(tmp);
  const origin = createHttpServer((_req, res) => res.end("origin ok"));
  const tlsOrigin = createTlsServer(
    { cert: readFileSync(certs.cert), key: readFileSync(certs.key) },
    (socket) => {
      socket.on("error", () => {});
      socket.pipe(socket);
    },
  );
  const listening = (server: {
    listen(port: number, host: string, cb: () => void): unknown;
    address(): unknown;
  }) =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  const originPort = await listening(origin);
  const tlsPort = await listening(tlsOrigin);
  cleanup.push(() => {
    origin.closeAllConnections();
    origin.close();
    tlsOrigin.close();
  });
  const loop = loopbackBed({ "allowed.test": { 80: originPort, 443: tlsPort } });
  const proxy = createProxy({
    clock: createSystemClock(),
    logger: silentLogger,
    limits,
    ...loop,
  });
  const listener = await proxy.listen(join(tmp, "p.s"), scopeOf());
  cleanup.push(async () => void (await listener.close()));
  const script = join(tmp, "fwd.py");
  writeFileSync(script, FORWARDER_SOURCE, { mode: 0o400 });
  const port = await freePort();
  const forwarder = spawn("python3", ["-I", "-S", script, listener.path, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => forwarder.once("exit", resolve));
  cleanup.push(() => {
    if (forwarder.pid !== undefined && forwarder.pid > 1) {
      try {
        process.kill(-forwarder.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    }
  });
  return { port, forwarder, exited, listener, cert: certs.cert };
}

const get = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "http://allowed.test/x",
        headers: { host: "allowed.test" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve(`${res.statusCode} ${body}`));
      },
    );
    req.on("error", reject);
    req.end();
  });

describe.runIf(hasPython)("the in-sandbox forwarder in front of the real proxy socket", () => {
  it("is ready the moment its parent exits: the first connection is accepted without a retry", async () => {
    const r = await rig();
    expect(await r.exited).toBe(0);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(r.port, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    socket.destroy();
  });

  it("carries plain HTTP to a local origin through the proxy", async () => {
    const r = await rig();
    await r.exited;
    expect(await get(r.port)).toBe("200 origin ok");
  });

  it("carries CONNECT to a local TLS origin end to end, certificate untouched", async () => {
    const r = await rig();
    await r.exited;
    const tunnel = await new Promise<Socket>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: r.port,
        method: "CONNECT",
        path: "allowed.test:443",
      });
      req.on("connect", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    const secure = tlsConnect({ socket: tunnel, servername: "allowed.test", rejectUnauthorized: false });
    const answer = await new Promise<string>((resolve, reject) => {
      secure.once("secureConnect", () => secure.write("hello tls"));
      secure.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      secure.once("error", reject);
    });
    expect(answer).toBe("hello tls");
    expect(secure.getPeerCertificate().fingerprint256).toBe(
      new X509Certificate(readFileSync(r.cert)).fingerprint256,
    );
    secure.destroy();
  });

  it("serves at most 64 connections at once and frees a slot when one closes", async () => {
    const r = await rig({ ...EGRESS_LIMITS, connections: 100 });
    await r.exited;
    const held: Socket[] = [];
    for (let i = 0; i < 64; i += 1) {
      held.push(
        await new Promise<Socket>((resolve) => {
          const s = connect(r.port, "127.0.0.1", () => resolve(s));
          s.on("error", () => {});
        }),
      );
    }
    await vi.waitFor(() => expect(held.filter((s) => !s.destroyed)).toHaveLength(64), { timeout: 5000 });
    const extra = connect(r.port, "127.0.0.1");
    extra.on("error", () => {});
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    held[0]?.destroy();
    await vi.waitFor(async () => expect(await get(r.port)).toBe("200 origin ok"), { timeout: 5000 });
    for (const s of held) s.destroy();
  });

  it("exits when its process group is killed", async () => {
    const r = await rig();
    await r.exited;
    expect(r.forwarder.pid).toBeGreaterThan(1);
    process.kill(-(r.forwarder.pid ?? 0), "SIGKILL");
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const s = connect(r.port, "127.0.0.1");
          s.once("connect", () => {
            s.destroy();
            reject(new Error("still listening"));
          });
          s.once("error", () => resolve());
        }),
      { timeout: 5000 },
    );
  });
});
