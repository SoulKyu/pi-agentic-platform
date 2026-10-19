import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { VMD_MAX_FRAME_BYTES, type VmdRequest } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VmdFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import { createVmdServer, REQUEST_READ_MS } from "./server.ts";
import { createFakeClock, type FakeClock } from "./testing/fake-clock.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-no-frame-bound: the request is buffered and parsed whatever its size: killed by "a request over 64 KiB is refused
 *    before it is parsed" (a padded request that is valid JSON must not run).
 *  - M-schema-bypassed: the handler gets `JSON.parse`'s result, not the schema's: killed by "an unknown key / op is
 *    bad_request and runs nothing".
 *  - M-mode-not-enforced: no chmod 0600 after the bind (the socket keeps the umask's mode): killed by "the socket is 0600".
 *  - M-owner-not-enforced: no chown to papUid:papGid: killed by "the socket is owned by papUid" (fake chown).
 *  - M-log-request: the logger gets the request: killed by "the log line of a vm.start has no token".
 */
const hex = (n: number, ch: string): string => ch.repeat(n);
const start = {
  op: "vm.start",
  agentId: "helper-1a2b",
  kind: "thread",
  taskKey: null,
  image: `pap-agent-agent-${hex(64, "b")}`,
  resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
  launchId: hex(32, "a"),
  token: hex(64, "c"),
};
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

let work: string;
let socketPath: string;
let clock: FakeClock;
let records: { event: string; fields: Record<string, unknown> }[];
let handled: VmdRequest[];
let handler: (request: VmdRequest) => Promise<unknown>;
let chowned: [string, number, number][];
let servers: { close(): Promise<void> }[];
const log: Logger = {
  info(event, fields) {
    records.push({ event, fields });
  },
};

function server(extra: Partial<Parameters<typeof createVmdServer>[0]> = {}) {
  const created = createVmdServer({
    socketPath,
    papUid: uid,
    papGid: gid,
    handle: (request) => {
      handled.push(request);
      return handler(request);
    },
    log,
    clock,
    chown: (file, u, g) => {
      chowned.push([file, u, g]);
    },
    ...extra,
  });
  servers.push(created);
  return created;
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "vmd-srv-"));
  socketPath = path.join(work, "vmd.sock");
  clock = createFakeClock();
  records = [];
  handled = [];
  chowned = [];
  servers = [];
  handler = async () => ({ done: true });
});
afterEach(async () => {
  for (const created of servers) await created.close();
  rmSync(work, { recursive: true, force: true });
});

function exchange(payload: Buffer | string | null, ending: "end" | "newline" | "none"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      if (payload !== null) socket.write(payload);
      if (ending === "newline") socket.write("\n");
      if (ending === "end") socket.end();
    });
  });
}
const call = async (request: unknown): Promise<unknown> =>
  JSON.parse(await exchange(JSON.stringify(request), "end")) as unknown;

describe("socket (R36)", () => {
  it("the socket is 0600 and chown'd to papUid:papGid", async () => {
    await server({ papUid: 4242, papGid: 4343 }).listen();
    const stat = lstatSync(socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(chowned).toEqual([[socketPath, 4242, 4343]]);
  });

  it("replaces a stale socket file left by a crash, refuses to replace anything else", async () => {
    execFileSync("python3", [
      "-I",
      "-c",
      "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
      socketPath,
    ]);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await server().listen();
    expect(await call({ op: "vm.list" })).toEqual({ ok: true, result: { done: true } });
    await servers[0]?.close();
    writeFileSync(socketPath, "a regular file");
    await expect(server().listen()).rejects.toThrow(/not a socket/);
    expect(existsSync(socketPath)).toBe(true);
  });

  it("close removes the socket file", async () => {
    const running = server();
    await running.listen();
    await running.close();
    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("one request per connection", () => {
  beforeEach(async () => {
    await server().listen();
  });

  it("answers a valid request with one response line, then closes; the handler gets the parsed request", async () => {
    handler = async () => ({ address: "10.213.0.2" });
    const raw = await exchange(
      JSON.stringify({ op: "vm.status", agentId: "helper-1a2b", taskKey: null }),
      "newline",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(raw)).toEqual({ ok: true, result: { address: "10.213.0.2" } });
    expect(handled).toEqual([{ op: "vm.status", agentId: "helper-1a2b", taskKey: null }]);
  });

  it("a request over 64 KiB is refused before it is parsed (a padded request that is valid JSON does not run)", async () => {
    const padded = `{"op":"vm.list"}${" ".repeat(VMD_MAX_FRAME_BYTES)}`;
    expect(Buffer.byteLength(padded)).toBeGreaterThan(VMD_MAX_FRAME_BYTES);
    expect(JSON.parse(await exchange(padded, "end"))).toEqual({ ok: false, code: "bad_request" });
    expect(handled).toEqual([]);
  });

  it("a request of exactly 64 KiB is read", async () => {
    const body = '{"op":"vm.list"}';
    const exact = body + " ".repeat(VMD_MAX_FRAME_BYTES - body.length);
    expect(Buffer.byteLength(exact)).toBe(VMD_MAX_FRAME_BYTES);
    expect(JSON.parse(await exchange(exact, "end"))).toEqual({ ok: true, result: { done: true } });
    expect(handled).toEqual([{ op: "vm.list" }]);
  });

  it("an oversize request without a closing newline or end is refused as soon as it is too big", async () => {
    const answer = await exchange(Buffer.alloc(VMD_MAX_FRAME_BYTES + 1, 0x20), "none");
    expect(JSON.parse(answer)).toEqual({ ok: false, code: "bad_request" });
    expect(handled).toEqual([]);
  });

  it.each([
    ["an unknown op", { op: "vm.destroy" }],
    ["an unknown key", { op: "vm.list", extra: 1 }],
    ["a field of the wrong shape", { op: "vm.stop", agentId: "../x", taskKey: null }],
    ["a missing field", { op: "vm.stop", agentId: "helper-1a2b" }],
    ["an array", [{ op: "vm.list" }]],
    ["null", null],
    ["a token of the wrong length", { ...start, token: "ab" }],
  ])("%s is bad_request and runs nothing", async (_name, request) => {
    expect(await call(request)).toEqual({ ok: false, code: "bad_request" });
    expect(handled).toEqual([]);
  });

  it("text that is not JSON, an empty request and bytes that are not UTF-8 are bad_request", async () => {
    for (const payload of ["not json", "", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])]) {
      expect(JSON.parse(await exchange(payload, "end"))).toEqual({ ok: false, code: "bad_request" });
    }
    expect(handled).toEqual([]);
  });

  it("a typed refusal keeps its code; any other error is `failed` and its message never reaches the client", async () => {
    handler = () => Promise.reject(new VmdFailure("conflict"));
    expect(await call({ op: "vm.list" })).toEqual({ ok: false, code: "conflict" });
    handler = () => Promise.reject(new Error("secret path /var/lib/pap-vm/1000"));
    const raw = await exchange(JSON.stringify({ op: "vm.list" }), "end");
    expect(JSON.parse(raw)).toEqual({ ok: false, code: "failed" });
    expect(raw).not.toContain("secret");
    expect(JSON.stringify(records)).not.toContain("secret path");
  });

  it("a response over 64 KiB is `failed`", async () => {
    handler = async () => ({ big: "x".repeat(VMD_MAX_FRAME_BYTES) });
    expect(await call({ op: "vm.list" })).toEqual({ ok: false, code: "failed" });
  });

  it("a result that cannot be serialised is `failed`", async () => {
    handler = async () => ({ n: 1n });
    expect(await call({ op: "vm.list" })).toEqual({ ok: false, code: "failed" });
  });

  it("a silent connection is answered bad_request after the read deadline", async () => {
    const answer = exchange(null, "none");
    await clock.advance(REQUEST_READ_MS - 1);
    await clock.advance(1);
    expect(JSON.parse(await answer)).toEqual({ ok: false, code: "bad_request" });
    expect(handled).toEqual([]);
    await vi.waitFor(() => expect(clock.pending()).toBe(0));
  });
});

describe("log (RT-33)", () => {
  beforeEach(async () => {
    await server().listen();
  });

  it("the log line of a vm.start has no token, only op, agentId, taskKey, result and ms", async () => {
    expect(await call(start)).toEqual({ ok: true, result: { done: true } });
    expect(records).toEqual([
      {
        event: "vmd_call",
        fields: { op: "vm.start", agentId: "helper-1a2b", taskKey: null, result: "ok", ms: 0 },
      },
    ]);
    const everything = JSON.stringify(records);
    expect(everything).not.toContain(start.token);
    expect(everything).not.toContain(start.launchId);
  });

  it("names the result of a refusal and a bad request", async () => {
    handler = () => Promise.reject(new VmdFailure("disk_low"));
    await call({ op: "disk.grow", agentId: "helper-1a2b", taskKey: null, diskMb: 8192 });
    await call({ op: "nope", token: start.token });
    expect(records.map((r) => r.fields)).toEqual([
      { op: "disk.grow", agentId: "helper-1a2b", taskKey: null, result: "disk_low", ms: 0 },
      { op: null, agentId: null, taskKey: null, result: "bad_request", ms: 0 },
    ]);
    expect(JSON.stringify(records)).not.toContain(start.token);
  });

  it("an op with no agent logs a null agent id", async () => {
    await call({ op: "vm.list" });
    expect(records[0]?.fields).toEqual({ op: "vm.list", agentId: null, taskKey: null, result: "ok", ms: 0 });
  });
});

describe("connections", () => {
  it("refuses a connection past the cap with `capacity`, and takes the next one when a slot frees", async () => {
    await server({ maxConnections: 2 }).listen();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = () => released.then(() => ({ done: true }));
    const holding = [exchange('{"op":"vm.list"}', "end"), exchange('{"op":"vm.list"}', "end")];
    await vi.waitFor(() => expect(handled).toHaveLength(2));
    expect(JSON.parse(await exchange(null, "none"))).toEqual({ ok: false, code: "capacity" });
    release();
    await Promise.all(holding);
    expect(await call({ op: "vm.list" })).toEqual({ ok: true, result: { done: true } });
  });
});
