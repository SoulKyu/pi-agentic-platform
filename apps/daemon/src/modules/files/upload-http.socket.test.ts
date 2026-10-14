import { readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { startServer } from "../../kernel/http/server.ts";
import { testCaller } from "../../testing/caller.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import { mountUploadRoute } from "./upload-http.ts";

const ORIGIN = "http://localhost:7777";
let bed: FilesBed;
let port: number;
let close: () => Promise<void>;
const sockets: Socket[] = [];

beforeEach(async () => {
  bed = createFilesBed();
  const service = createFilesService({
    roots: () => [bed.repo],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
  });
  const server = await startServer({
    app: createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger: bed.logger,
      mount: (hono) => mountUploadRoute(hono, { caller: () => testCaller(), service, logger: bed.logger }),
      wsProbe: (c) => c.text("no"),
    }),
    host: "127.0.0.1",
    port: 0,
    tls: null,
    onUpgrade: (_req, socket) => socket.destroy(),
    onError: () => {},
  });
  ({ port, close } = server);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await close();
  bed.dispose();
});

const open = (): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
    sockets.push(socket);
  });
const head = (name: string, extra: string[]): string =>
  [
    `PUT /files/raw?path=${encodeURIComponent(join(bed.repo, name))}&conflict=skip HTTP/1.1`,
    "Host: 127.0.0.1",
    `Origin: ${ORIGIN}`,
    ...extra,
    "",
    "",
  ].join("\r\n");
const answerOf = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    socket.on("data", (data: Buffer) => {
      text += data.toString("latin1");
      if (text.includes("\r\n\r\n") && text.includes("}")) resolve(text);
    });
  });
const leftovers = () => readdirSync(bed.repo).filter((name) => name.endsWith(".tmp") || name === "short.bin");

describe("PUT /files/raw over a socket", () => {
  it("keeps no file and no temporary file when the client stops mid-body", async () => {
    const socket = await open();
    socket.write(head("short.bin", ["Content-Length: 100000"]) + "0123456789");
    // The route has read the first bytes (it opened its temporary file): now the client goes away.
    await vi.waitFor(() => expect(bed.lines.some((line) => line.msg === "upload_started")).toBe(true), {
      timeout: 5_000,
    });
    socket.destroy();
    await vi.waitFor(() => expect(bed.lines.some((line) => line.msg === "upload_interrupted")).toBe(true), {
      timeout: 5_000,
    });
    expect(leftovers()).toEqual([]);
  });

  it("answers 400 to a chunked body without a length and writes nothing", async () => {
    const socket = await open();
    const answer = answerOf(socket);
    socket.write(head("chunked.bin", ["Transfer-Encoding: chunked"]) + "3\r\nabc\r\n0\r\n\r\n");
    const text = await answer;
    expect(text.startsWith("HTTP/1.1 400")).toBe(true);
    expect(text).toContain('"bad_request"');
    expect(readdirSync(bed.repo)).not.toContain("chunked.bin");
    expect(leftovers()).toEqual([]);
  });
});
