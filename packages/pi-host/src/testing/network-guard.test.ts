import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedAttempts } from "./network-guard.ts";

// This file loads the guard, so every socket this process opens is under it. Each test aims at a closed local
// port: a guard that lets the attempt through ends in ECONNREFUSED, never in the guard's own message.
const GUARD_MESSAGE = "network access is disabled in tests";

function messagesOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const nested = [error.cause, ...(error instanceof AggregateError ? error.errors : [])];
  return [error.message, ...nested.flatMap((inner) => (inner === undefined ? [] : messagesOf(inner)))];
}

async function failureOf(attempt: () => unknown): Promise<unknown> {
  try {
    await attempt();
  } catch (error) {
    return error;
  }
  throw new Error("the attempt did not fail");
}

const eventually = (open: (fail: (error: unknown) => void) => void) =>
  failureOf(
    () =>
      new Promise((_resolve, reject) => {
        try {
          open(reject);
        } catch (error) {
          reject(error);
        }
      }),
  );

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let port: number;
let before: number;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  port = await closedPort();
  before = blockedAttempts.length;
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const refused = (error: unknown) => {
  expect(messagesOf(error)).toContain(GUARD_MESSAGE);
  expect(blockedAttempts.length).toBeGreaterThan(before);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("pap-network-guard: blocked"));
};

describe("the network guard refuses every TCP connection, loopback included", () => {
  it("fetch over http and https", async () => {
    refused(await failureOf(() => fetch(`https://127.0.0.1:${port}/`)));
    refused(await failureOf(() => fetch(`http://127.0.0.1:${port}/`)));
  });

  it("https.get and http.get", async () => {
    refused(await eventually((fail) => https.get(`https://127.0.0.1:${port}/`).on("error", fail)));
    refused(await eventually((fail) => http.get(`http://127.0.0.1:${port}/`).on("error", fail)));
  });

  it("tls.connect", async () => {
    const error = await eventually((fail) =>
      tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }).on("error", fail),
    );
    refused(error);
  });

  it("net.connect in every spelling of 'no unix socket'", async () => {
    const spellings: Array<() => net.Socket> = [
      () => net.connect(port, "127.0.0.1"),
      () => net.connect({ host: "127.0.0.1", port }),
      () => net.connect({ host: "127.0.0.1", port, path: undefined }),
      () => net.connect({ host: "127.0.0.1", port, path: "" }),
      () => net.connect(String(port)),
    ];
    for (const open of spellings) {
      const countBefore = blockedAttempts.length;
      refused(await eventually((fail) => open().on("error", fail)));
      expect(blockedAttempts.length).toBe(countBefore + 1);
    }
  });
});

describe("the network guard lets a unix socket through", () => {
  let dir: string;
  let path: string;
  let server: net.Server;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pap-guard-"));
    path = join(dir, "s.sock");
    server = net.createServer((socket) => socket.end("pong"));
    await new Promise<void>((resolve) => server.listen(path, resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const answer = (open: () => net.Socket) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      open()
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks).toString()))
        .on("error", reject);
    });

  it("by path, as a string or in the options", async () => {
    expect(await answer(() => net.connect(path))).toBe("pong");
    expect(await answer(() => net.connect({ path }))).toBe("pong");
    expect(blockedAttempts.length).toBe(before);
  });
});
