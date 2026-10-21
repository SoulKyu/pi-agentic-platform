import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FILE_LIMITS } from "@pap/contracts";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { httpCaller } from "../../kernel/http/caller.ts";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createAgentFiles } from "./agent-files.ts";
import { mountAgentFilesRoute } from "./agent-files-http.ts";
import { createAgentFilesService } from "./agent-files-service.ts";

const ORIGIN = "http://localhost:7777";
const AGENT = "atlas-0000";
let root: string;
let secrets: string;
let app: Hono;
let files: ReturnType<typeof createAgentFiles>;
const audit = { append: vi.fn() };

const caller = httpCaller((header) => (header === "pap=ok" ? testCaller() : null));
const put = (
  query: string,
  body: string | Buffer | null,
  headers: Record<string, string> = {},
  declare: number | null = body === null ? null : Buffer.byteLength(body),
) =>
  app.request(`/agent-files?${query}`, {
    method: "PUT",
    body,
    headers: {
      origin: ORIGIN,
      cookie: "pap=ok",
      ...(declare === null ? {} : { "content-length": String(declare) }),
      ...headers,
    },
    duplex: "half",
  } as RequestInit);
const ok = `agentId=${AGENT}&path=.kube/config`;
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-agent-files-http-"));
  secrets = join(root, "secrets");
  audit.append.mockClear();
  files = createAgentFiles({ secretsDir: secrets, logger: captureLogger().logger });
  const service = createAgentFilesService({
    files,
    owns: (ownerId, agentId) => ownerId === "u1" && agentId === AGENT,
    audit,
  });
  app = createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: captureLogger().logger,
    mount: (hono) => mountAgentFilesRoute(hono, { caller, service, logger: captureLogger().logger }),
    wsProbe: (c) => c.text("no"),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("PUT /agent-files", () => {
  it("imports a file, answers its view and keeps it 0600 under the agent's folder", async () => {
    const res = await put(ok, "apiVersion: v1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: ".kube/config", size: 14, importedAt: expect.any(Number) });
    expect(readFileSync(join(secrets, "agent-files", AGENT, ".kube", "config"), "utf8")).toBe(
      "apiVersion: v1",
    );
    expect(audit.append).toHaveBeenCalledOnce();
  });

  it("replaces the file at the same path", async () => {
    await put(ok, "one");
    expect((await put(ok, "second")).status).toBe(200);
    expect(files.list(AGENT)).toMatchObject([{ path: ".kube/config", size: 6 }]);
  });

  it("answers 401 without a cookie and to a bearer, 403 without agents:admin", async () => {
    expect((await put(ok, "x", { cookie: "" })).status).toBe(401);
    expect((await put(ok, "x", { authorization: "Bearer t" })).status).toBe(401);
    const weak = httpCaller(() => testCaller({ permissions: new Set(["agents:read"]) }));
    const service = createAgentFilesService({ files, owns: () => true, audit });
    const weakApp = createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger: captureLogger().logger,
      mount: (hono) => mountAgentFilesRoute(hono, { caller: weak, service, logger: captureLogger().logger }),
      wsProbe: (c) => c.text("no"),
    });
    const res = await weakApp.request(`/agent-files?${ok}`, {
      method: "PUT",
      body: "x",
      headers: { origin: ORIGIN, cookie: "pap=ok", "content-length": "1" },
    });
    expect(res.status).toBe(403);
    expect(files.list(AGENT)).toEqual([]);
  });

  it("is refused without an allowed Origin by the app's guard", async () => {
    expect((await put(ok, "x", { origin: "http://evil.example" })).status).toBe(403);
    expect(
      (
        await app.request(`/agent-files?${ok}`, {
          method: "PUT",
          body: "x",
          headers: { cookie: "pap=ok", "content-length": "1" },
        })
      ).status,
    ).toBe(403);
    expect(files.list(AGENT)).toEqual([]);
  });

  it("answers 404 for an agent that is not the owner's, before reading the body", async () => {
    const res = await put("agentId=borea-0001&path=a", "x");
    expect(res.status).toBe(404);
    expect(existsSync(join(secrets, "agent-files"))).toBe(false);
  });

  it("answers 400 to a missing or bad agentId or path", async () => {
    for (const query of [
      "",
      `agentId=${AGENT}`,
      "path=a",
      `agentId=${AGENT}&path=../x`,
      `agentId=${AGENT}&path=/etc/passwd`,
      `agentId=${AGENT}&path=a//b`,
      `agentId=${AGENT}&path=a/./b`,
      "agentId=..%2Fx&path=a",
    ]) {
      const res = await put(query, "x");
      expect(res.status, query).toBe(400);
    }
    expect(files.list(AGENT)).toEqual([]);
  });

  it("answers 413 above the cap on the declared length, without reading the body, and accepts exactly the cap", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => undefined });
    const refused = await app.request(`/agent-files?${ok}`, {
      method: "PUT",
      body,
      headers: { origin: ORIGIN, cookie: "pap=ok", "content-length": String(AGENT_FILE_LIMITS.maxBytes + 1) },
      duplex: "half",
    } as RequestInit);
    expect(refused.status).toBe(413);
    expect(body.locked).toBe(false);
    expect(files.list(AGENT)).toEqual([]);
    expect((await put(ok, Buffer.alloc(AGENT_FILE_LIMITS.maxBytes))).status).toBe(200);
  });

  it("answers 400 without a content-length, and writes nothing for a body longer than it declared", async () => {
    expect((await put(ok, null, {}, null)).status).toBe(400);
    const longer = await put(ok, "0123456789", {}, 4);
    expect(longer.status).toBeGreaterThanOrEqual(400);
    expect(files.list(AGENT)).toEqual([]);
    const folder = join(secrets, "agent-files", AGENT);
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });

  it("answers 409 for the 33rd file, and 409 when a folder is in the way", async () => {
    for (let n = 0; n < AGENT_FILE_LIMITS.maxFiles; n += 1)
      expect((await put(`agentId=${AGENT}&path=f${n}`, "x")).status).toBe(200);
    const full = await put(`agentId=${AGENT}&path=extra`, "x");
    expect([full.status, await codeOf(full)]).toEqual([409, "limit_reached"]);
    expect((await put(`agentId=${AGENT}&path=f0`, "replaced")).status).toBe(200);
  });

  it("does not answer a GET", async () => {
    const res = await app.request(`/agent-files?${ok}`, { headers: { cookie: "pap=ok" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
