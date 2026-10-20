import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VMD_MAX_FRAME_BYTES, type VmdRequest } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { BUILD_DEADLINE_MS, createVmdClient, DEFAULT_DEADLINE_MS, VmdError } from "./vmd-client.ts";

// Mutants (RT-43 style, run for real in the T15a report): "answer bound dropped" (the 70 KiB case resolves), "single line
// check dropped" (a second line is read as the answer), "deadline per op dropped" (the build case rejects at 60 s),
// "request parsed no more" (the invalid-request case connects), "error carries the request" (the token case).
let dir: string;
let socket: string;
let server: net.Server;
let clock: FakeClock;
const connections: net.Socket[] = [];
const received: string[] = [];
let answer: (text: string, conn: net.Socket) => void = () => {};

const LIST: VmdRequest = { op: "vm.list" };
const TOKEN = "ab".repeat(32);
const START: VmdRequest = {
  op: "vm.start",
  agentId: "scout-0001",
  kind: "thread",
  taskKey: null,
  image: `pap-agent-agent-${"a".repeat(64)}`,
  resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
  launchId: "cd".repeat(16),
  token: TOKEN,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pap-t15-vmdc-"));
  socket = join(dir, "vmd.sock");
  clock = createFakeClock();
  received.length = 0;
  connections.length = 0;
  answer = (_text, conn) => void conn.end(`${JSON.stringify({ ok: true, result: { vms: [] } })}\n`);
  server = net.createServer({ allowHalfOpen: true }, (conn) => {
    connections.push(conn);
    let text = "";
    conn.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    conn.on("end", () => {
      received.push(text);
      answer(text, conn);
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterEach(async () => {
  for (const conn of connections) conn.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const client = () => createVmdClient(socket, clock);

describe("vmd client", () => {
  it("sends one JSON line per connection and returns the result", async () => {
    await expect(client().request(LIST)).resolves.toEqual({ vms: [] });
    await client().request(LIST);
    expect(received).toEqual(['{"op":"vm.list"}\n', '{"op":"vm.list"}\n']);
    expect(connections).toHaveLength(2);
  });

  it.each(["bad_request", "not_found", "conflict", "capacity", "disk_low", "unavailable", "failed"] as const)(
    "turns an ok:false answer into a VmdError carrying %s",
    async (code) => {
      answer = (_text, conn) => void conn.end(`${JSON.stringify({ ok: false, code })}\n`);
      await expect(client().request(LIST)).rejects.toMatchObject({ name: "VmdError", code });
    },
  );

  it("reads an answer the server ends without a newline", async () => {
    answer = (_text, conn) => void conn.end(JSON.stringify({ ok: true, result: { a: 1 } }));
    await expect(client().request(LIST)).resolves.toEqual({ a: 1 });
  });

  it("refuses an answer over 64 KiB and closes the connection", async () => {
    const huge = JSON.stringify({ ok: true, result: { pad: "x".repeat(VMD_MAX_FRAME_BYTES + 10) } });
    answer = (_text, conn) => void conn.end(`${huge}\n`);
    await expect(client().request(LIST)).rejects.toMatchObject({ name: "VmdError", code: "protocol" });
  });

  it("refuses an answer that is not one VmdResponse, or has a second line", async () => {
    answer = (_text, conn) => void conn.end('{"ok":"yes"}\n');
    await expect(client().request(LIST)).rejects.toMatchObject({ code: "protocol" });
    answer = (_text, conn) => void conn.end('{"ok":true,"result":1}\n{"ok":true,"result":2}\n');
    await expect(client().request(LIST)).rejects.toMatchObject({ code: "protocol" });
    answer = (_text, conn) => void conn.end("not json\n");
    await expect(client().request(LIST)).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses a request the schema refuses before connecting", async () => {
    const before = connections.length;
    const bad = { op: "vm.start", agentId: "../x" } as unknown as VmdRequest;
    await expect(client().request(bad)).rejects.toMatchObject({ code: "bad_request" });
    expect(connections).toHaveLength(before);
  });

  it("answers unavailable when the socket is not there", async () => {
    await expect(createVmdClient(join(dir, "none.sock"), clock).request(LIST)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("gives up after 60 s, and after 10 minutes for an image build", async () => {
    answer = () => {};
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: VmdError) => error.code,
      );
    const listing = outcome(client().request(LIST));
    await expect.poll(() => received.length).toBe(1);
    await clock.advance(DEFAULT_DEADLINE_MS - 1);
    await clock.advance(1);
    await expect(listing).resolves.toBe("timeout");
    const build: VmdRequest = {
      op: "image.build",
      layer: "agent",
      tag: `pap-agent-agent-${"b".repeat(64)}`,
      from: `pap-agent-profile-${"c".repeat(64)}`,
      aptPackages: ["git"],
      upgrade: false,
    };
    const building = outcome(client().request(build));
    await expect.poll(() => received.length).toBe(2);
    await clock.advance(DEFAULT_DEADLINE_MS * 2);
    let settled = false;
    void building.then(() => (settled = true));
    await clock.advance(1);
    expect(settled).toBe(false);
    await clock.advance(BUILD_DEADLINE_MS);
    await expect(building).resolves.toBe("timeout");
    expect(clock.pending()).toBe(0);
  });

  it("never puts the request, and so the launch token, in an error", async () => {
    answer = (_text, conn) => void conn.end(`${JSON.stringify({ ok: false, code: "failed" })}\n`);
    const error = await client()
      .request(START)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(VmdError);
    expect(
      JSON.stringify(error) + String((error as Error).message) + String((error as Error).stack),
    ).not.toContain(TOKEN);
    expect(received[0]).toContain(TOKEN);
  });
});
