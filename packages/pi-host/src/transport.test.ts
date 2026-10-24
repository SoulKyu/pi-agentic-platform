import net from "node:net";
import { createFrameDecoder, AGENT_VM_MAX_FRAME_BYTES } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFacts, TOKEN_FD, transportFromEnv } from "./transport.ts";

const TOKEN = "b".repeat(64);
const NAMES = [
  "PAP_GATEWAY",
  "PAP_LAUNCH_ID",
  "PAP_BOX",
  "PAP_WORKER_SLOT",
  "PAP_IMAGE_TAG",
  "PAP_SESSION_FILE",
];

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const name of NAMES) Reflect.deleteProperty(process.env, name);
  delete process.env.PAP_GATEWAY_TOKEN;
  Object.assign(process.env, { PAP_WORKER_TRANSPORT: saved.PAP_WORKER_TRANSPORT });
  if (saved.PAP_WORKER_TRANSPORT === undefined) delete process.env.PAP_WORKER_TRANSPORT;
});

async function gateway(): Promise<{ port: number; first: Promise<unknown> }> {
  const server = net.createServer();
  servers.push(server);
  const first = new Promise<unknown>((resolve) => {
    server.once("connection", (socket) => {
      sockets.push(socket);
      const decoder = createFrameDecoder({
        maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
        onFrame: (value) => {
          decoder.stop();
          resolve(value);
        },
        onError: () => undefined,
      });
      socket.on("data", (chunk) => decoder.push(chunk));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, first };
}

const envFor = (port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = {
    PAP_WORKER_TRANSPORT: "socket",
    PAP_GATEWAY: `127.0.0.1:${port}`,
    PAP_LAUNCH_ID: "a".repeat(32),
    PAP_BOX: "agent:scout-ab12",
    PAP_WORKER_SLOT: "d".repeat(32),
    PAP_IMAGE_TAG: `pap-agent-agent-${"c".repeat(64)}`,
    ...extra,
  };
  Object.assign(process.env, env);
  return process.env;
};

describe("transportFromEnv", () => {
  it("reads the token from the token reader, never from the environment, and sends the hello first", async () => {
    const { port, first } = await gateway();
    const env = envFor(port, { PAP_GATEWAY_TOKEN: "e".repeat(64) });
    const ipc = await transportFromEnv(env, () => TOKEN);
    expect(ipc.send({ type: "health", rssMb: 1 })).toBe(true);
    expect(await first).toMatchObject({
      type: "hello",
      role: "worker",
      token: TOKEN,
      box: { kind: "agent", id: "scout-ab12" },
      slot: "d".repeat(32),
      session: { file: null, lastEntryId: null, size: 0 },
    });
  });

  it("deletes the six names from process.env even when env is another object", async () => {
    const { port } = await gateway();
    envFor(port);
    await transportFromEnv({ ...process.env }, () => TOKEN);
    for (const name of NAMES) expect(process.env[name]).toBeUndefined();
  });

  it("sends the token without the newline its writer may have added", async () => {
    const { port, first } = await gateway();
    await transportFromEnv(envFor(port), () => `${TOKEN}\n`);
    expect(await first).toMatchObject({ token: TOKEN });
  });

  it("deletes the six names from process.env", async () => {
    const { port } = await gateway();
    const env = envFor(port);
    await transportFromEnv(env, () => TOKEN);
    for (const name of NAMES) expect(process.env[name]).toBeUndefined();
  });

  it.each(["", "zz", "B".repeat(64), "b".repeat(63), `${"b".repeat(64)}00`])(
    "rejects a malformed token (%j) before connecting",
    async (bad) => {
      const { port } = await gateway();
      const env = envFor(port);
      await expect(transportFromEnv(env, () => bad)).rejects.toThrow("gateway token");
    },
  );

  it("rejects a missing variable and a bad gateway address", async () => {
    const { port } = await gateway();
    const env = envFor(port);
    delete env.PAP_BOX;
    await expect(transportFromEnv(env, () => TOKEN)).rejects.toThrow("PAP_BOX");
    envFor(port, { PAP_GATEWAY: "nope" });
    await expect(transportFromEnv(process.env, () => TOKEN)).rejects.toThrow("PAP_GATEWAY");
  });

  it("puts the facts of the named session file in the hello", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-t4-"));
    dirs.push(dir);
    const file = join(dir, "s1.jsonl");
    const body = `${JSON.stringify({ type: "session", id: "first" })}\n${JSON.stringify({ id: "e2" })}\n`;
    writeFileSync(file, body);
    const { port, first } = await gateway();
    const env = envFor(port, { PAP_SESSION_FILE: file });
    await transportFromEnv(env, () => TOKEN);
    expect(await first).toMatchObject({
      session: { file: "s1.jsonl", lastEntryId: "e2", size: Buffer.byteLength(body) },
    });
  });

  it("reports a refused connection", async () => {
    const env = envFor(1);
    await expect(transportFromEnv(env, () => TOKEN)).rejects.toThrow();
  });
});

describe("sessionFacts", () => {
  it("is empty for an absent path or file", () => {
    expect(sessionFacts(undefined)).toEqual({ file: null, lastEntryId: null, size: 0 });
    expect(sessionFacts("/nonexistent-pap-t4/s.jsonl")).toEqual({ file: null, lastEntryId: null, size: 0 });
  });

  it("keeps the size and a null id when the last line has no usable id or the name is not a session name", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-t4-"));
    dirs.push(dir);
    const file = join(dir, "s2.jsonl");
    writeFileSync(file, '{"type":"session"}\nnot json\n');
    expect(sessionFacts(file)).toEqual({ file: "s2.jsonl", lastEntryId: null, size: 28 });
    const odd = join(dir, "bad name.txt");
    writeFileSync(odd, "{}\n");
    expect(sessionFacts(odd)).toEqual({ file: null, lastEntryId: null, size: 0 });
  });

  it("does not read more than the tail: a last line over the tail has no id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-t4-"));
    dirs.push(dir);
    const file = join(dir, "s3.jsonl");
    const line = JSON.stringify({ id: "big", pad: "x".repeat(2 * 1024 * 1024) });
    writeFileSync(file, `${JSON.stringify({ id: "small" })}\n${line}\n`);
    expect(sessionFacts(file).lastEntryId).toBeNull();
  });

  it("reads the token from fd 3", () => {
    expect(TOKEN_FD).toBe(3);
  });
});
