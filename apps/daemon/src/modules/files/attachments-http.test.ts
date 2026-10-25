import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDenySet } from "../../kernel/fs/deny-set.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { httpCaller, type HttpCaller } from "../../kernel/http/caller.ts";
import { testCaller } from "../../testing/caller.ts";
import { createAttachmentsStore, type AttachmentsStore } from "./attachments-store.ts";
import { mountAttachmentsRoute } from "./attachments-http.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";

const ORIGIN = "http://localhost:7777";
const MIB = 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let bed: FilesBed;
let dir: string;
let store: AttachmentsStore;

const storeOf = (limits?: { count: number; bytes: number }): AttachmentsStore =>
  createAttachmentsStore({
    dir,
    clock: bed.clock,
    logger: bed.logger,
    deny: createDenySet(bed.bb.denySources([dir]), bed.clock),
    limits,
  });
const owner: HttpCaller = () => testCaller();
function appOf(caller: HttpCaller = owner, readOnly = false): Hono {
  return createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (hono) => mountAttachmentsRoute(hono, { caller, store, logger: bed.logger, readOnly }),
    wsProbe: (c) => c.text("no"),
  });
}
type Body = string | Buffer | ReadableStream<Uint8Array> | null;
const post = (
  app: Hono,
  query: string,
  body: Body,
  headers: Record<string, string> = {},
  declare: number | null = typeof body === "string" || Buffer.isBuffer(body) ? Buffer.byteLength(body) : null,
) =>
  app.request(`/upload?${query}`, {
    method: "POST",
    body,
    headers: {
      origin: ORIGIN,
      ...(declare === null ? {} : { "content-length": String(declare) }),
      ...headers,
    },
    duplex: "half",
  } as RequestInit);
const ok = "sessionId=s1&name=a.txt";
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
const pendingOf = (): string[] => (existsSync(join(dir, "pending")) ? readdirSync(join(dir, "pending")) : []);
const idle = (controllers: ReadableStreamDefaultController<Uint8Array>[], pulls: { n: number }) =>
  new ReadableStream<Uint8Array>(
    { start: (controller) => void controllers.push(controller), pull: () => void pulls.n++ },
    { highWaterMark: 0 },
  );

beforeEach(() => {
  bed = createFilesBed();
  dir = join(bed.bb.papHome, "attachments");
  store = storeOf();
});
afterEach(() => {
  store.stop();
  bed.dispose();
});

describe("POST /upload (M8R37)", () => {
  it("answers 201 with an image view for a PNG and a file view for a PDF", async () => {
    const png = await post(appOf(), "sessionId=s1&name=p.png", PNG);
    expect(png.status).toBe(201);
    expect(await png.json()).toMatchObject({ kind: "image", mimeType: "image/png", name: "p.png", size: 12 });
    const pdf = await post(appOf(), "sessionId=s1&name=a.pdf", Buffer.from("%PDF-1.7 hello"), {
      "content-type": "image/png",
    });
    expect(pdf.status).toBe(201);
    expect(await pdf.json()).toMatchObject({ kind: "file", mimeType: null });
    expect(pendingOf()).toHaveLength(2);
  });

  it("answers 401 without a cookie and to a bearer, 403 without sessions:operate", async () => {
    const real = httpCaller((header) => (header === "pap=ok" ? testCaller() : null), NO_CLIENT_PATHS);
    expect((await post(appOf(real), ok, "x")).status).toBe(401);
    expect((await post(appOf(real), ok, "x", { authorization: "Bearer t", cookie: "pap=ok" })).status).toBe(
      401,
    );
    const weak = httpCaller(() => testCaller({ permissions: new Set(["files:read"]) }), NO_CLIENT_PATHS);
    expect((await post(appOf(weak), ok, "x", { cookie: "pap=ok" })).status).toBe(403);
    expect(pendingOf()).toEqual([]);
  });

  it("answers 400 to a missing or malformed sessionId or name, and to a name with a bidi control", async () => {
    for (const query of [
      "name=a.txt",
      "sessionId=s1",
      "sessionId=..%2Fx&name=a.txt",
      "sessionId=&name=a.txt",
      `sessionId=${"a".repeat(129)}&name=a.txt`,
      "sessionId=s1&name=a%E2%80%AEb.txt",
      "sessionId=s1&name=..",
      "sessionId=s1&name=a%2Fb",
    ])
      expect((await post(appOf(), query, "x")).status, query).toBe(400);
    expect(pendingOf()).toEqual([]);
  });

  it("answers 400 without a length and 413 above 25 MiB, before the body is pulled", async () => {
    const missing = await post(appOf(), ok, "x", {}, null);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("connection")).toBe("close");
    const pulls = { n: 0 };
    const big = await post(appOf(), ok, idle([], pulls), {}, 25 * MIB + 1);
    expect(big.status).toBe(413);
    expect(big.headers.get("connection")).toBe("close");
    expect(pulls.n).toBe(0);
    expect(pendingOf()).toEqual([]);
  });

  it("answers 413 when the body is longer than announced, with no file left", async () => {
    const res = await post(appOf(), ok, Buffer.alloc(10, 1), {}, 5);
    expect(res.status).toBe(413);
    expect(pendingOf()).toEqual([]);
  });

  it("answers 503 read_only before the length is looked at or the body pulled", async () => {
    const pulls = { n: 0 };
    const res = await post(appOf(owner, true), ok, idle([], pulls), {}, null);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("read_only");
    expect(pulls.n).toBe(0);
  });

  it("refuses with 409 limit_reached before the body is read when the declared bytes do not fit", async () => {
    store.stop();
    store = storeOf({ count: 32, bytes: 100 });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pulls = { n: 0 };
    const app = appOf();
    const held = [0, 1, 2].map(() => post(app, ok, idle(controllers, pulls), {}, 30));
    await vi.waitFor(() => expect(pulls.n).toBe(3), { timeout: 5_000 });
    const fourth = await post(app, ok, idle(controllers, pulls), {}, 30);
    expect(fourth.status).toBe(409);
    expect(await codeOf(fourth)).toBe("limit_reached");
    expect(pulls.n).toBe(3);
    // The three arriving uploads each hold one temporary file; the refused fourth left nothing.
    expect(pendingOf().filter((name) => !name.endsWith(".tmp"))).toEqual([]);
    expect(pendingOf()).toHaveLength(3);
    for (const controller of controllers.slice(0, 3)) {
      controller.enqueue(new Uint8Array(30).fill(1));
      controller.close();
    }
    expect((await Promise.all(held)).map((res) => res.status)).toEqual([201, 201, 201]);
    expect(pendingOf()).toHaveLength(3);
  });

  it("answers 503 capacity to a fifth concurrent request, before its body is read", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pulls = { n: 0 };
    const app = appOf();
    const held = [0, 1, 2, 3].map(() => post(app, ok, idle(controllers, pulls), {}, 2));
    await vi.waitFor(() => expect(pulls.n).toBe(4), { timeout: 5_000 });
    const fifth = await post(app, ok, idle(controllers, pulls), {}, 2);
    expect(fifth.status).toBe(503);
    expect(await codeOf(fifth)).toBe("capacity");
    expect(pulls.n).toBe(4);
    for (const controller of controllers.slice(0, 4)) {
      controller.enqueue(new Uint8Array([104, 105]));
      controller.close();
    }
    expect((await Promise.all(held)).map((res) => res.status)).toEqual([201, 201, 201, 201]);
    expect((await post(app, ok, "hi")).status).toBe(201);
  });

  it("leaves no file and cancels the reservation when the body is aborted", async () => {
    store.stop();
    store = storeOf({ count: 1, bytes: 100 });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pulls = { n: 0 };
    const app = appOf();
    const aborted = post(app, ok, idle(controllers, pulls), {}, 10);
    await vi.waitFor(() => expect(pulls.n).toBe(1), { timeout: 5_000 });
    controllers[0]?.enqueue(new Uint8Array([1, 2]));
    controllers[0]?.error(new Error("client went away"));
    const res = await Promise.resolve(aborted).catch(() => null);
    if (res !== null) expect(res.status).toBe(400);
    expect(pendingOf()).toEqual([]);
    expect((await post(app, ok, "ok")).status).toBe(201);
  });

  it("is refused without an Origin by the app's guard", async () => {
    const res = await appOf().request(`/upload?${ok}`, {
      method: "POST",
      body: "x",
      headers: { "content-length": "1" },
    });
    expect(res.status).toBe(403);
    expect(pendingOf()).toEqual([]);
  });
});
