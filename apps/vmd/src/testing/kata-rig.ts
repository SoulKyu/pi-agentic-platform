import { accessSync, constants, statSync } from "node:fs";
import net from "node:net";
import { randomBytes } from "node:crypto";

/** T20a: the real pap-vmd on this host (KVM). These helpers are for `*.kata.int.test.ts` only; nothing here fakes a tool. */
export const VMD_SOCKET = "/run/pap-vm/vmd.sock";
const GATEWAY = { host: "10.213.0.1", port: 7841 };

export function kataUnavailable(): string | null {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return "/dev/kvm is missing or not usable by this user";
  }
  try {
    if (!statSync(VMD_SOCKET).isSocket()) return `${VMD_SOCKET} is not a socket`;
  } catch {
    return `${VMD_SOCKET} is missing (pap-vmd is not installed or not running)`;
  }
  return null;
}

let warned = false;
/** True when the Kata tests must be skipped: one warning, never under `CI=1` (there a missing stack fails the run). */
export function skipKata(): boolean {
  const reason = kataUnavailable();
  if (reason === null) return false;
  if (process.env.CI === "1") throw new Error(`the Kata tests need the real stack: ${reason}`);
  if (!warned) process.stderr.write(`Kata tests skipped: ${reason}\n`);
  warned = true;
  return true;
}

export type VmdAnswer = { ok: true; result: unknown } | { ok: false; code: string };

/** One request per connection, like the daemon's client; no deadline but the caller's (a build takes minutes). */
export function vmd(request: object): Promise<VmdAnswer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect({ path: VMD_SOCKET });
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as VmdAnswer);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function vmdOk<T = unknown>(request: object): Promise<T> {
  const answer = await vmd(request);
  if (!answer.ok) throw new Error(`pap-vmd refused ${JSON.stringify(request).slice(0, 60)}: ${answer.code}`);
  return answer.result as T;
}

/** Waits for a real condition (a VM booting, a state changing) with a deadline. */
export async function until(
  label: string,
  check: () => Promise<boolean> | boolean,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** An agent id of the test's own, never one a real agent has: `t20a-<4 hex>`. */
export const testAgentId = (): string => `t20a-${hex(2)}`;

/** Listens where the daemon's gateway would (pap0's address) and records who connected: a guest's hello proves the bridge path. */
export async function listenGateway(): Promise<{ peers: string[]; close(): Promise<void> }> {
  const peers: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    peers.push(socket.remoteAddress ?? "");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(GATEWAY.port, GATEWAY.host, resolve);
  });
  return {
    peers,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
