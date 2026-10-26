import { appendFileSync, linkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PapError } from "@pap/contracts";
import { createFakeBoxOps, createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import { testCaller } from "../../testing/caller.ts";
import { MAX_INLINE_BYTES, mountRawRoute, RAW_CSP, RAW_HEADERS } from "./raw-http.ts";
import { createFilesService, type FilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const realService = (): FilesService =>
  createFilesService({
    isMember: () => false,
    roots: () => [bed.repo],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
  });
const allow: HttpCaller = () => testCaller();

function appOf(service: FilesService = realService(), caller: HttpCaller = allow): Hono {
  return createHttpApp({
    allowedOrigins: new Set(["http://localhost:7777"]),
    staticRoot: null,
    logger: bed.logger,
    mount: (hono) => mountRawRoute(hono, { caller, service, logger: bed.logger }),
    wsProbe: (c) => c.text("no"),
  });
}
const raw = (app: Hono, path: string, extra = "", init?: RequestInit) =>
  app.request(`/files/raw?path=${encodeURIComponent(path)}${extra}`, init);
const headersOf = (res: Response, names: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(names.map((name) => [name, res.headers.get(name)]));

describe("GET /files/raw", () => {
  it("serves a png inline with exactly the sandbox headers and no disposition", async () => {
    const path = bed.file(join(bed.repo, "a.png"), "PNGDATA");
    const res = await raw(appOf(), path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(headersOf(res, Object.keys(RAW_HEADERS))).toEqual(RAW_HEADERS);
    expect(res.headers.get("content-security-policy")).toBe(RAW_CSP);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-length")).toBe("7");
    expect(await res.text()).toBe("PNGDATA");
  });

  it("serves an svg as an image under the sandbox policy, not the page policy", async () => {
    const path = bed.file(join(bed.repo, "a.svg"), "<svg onload=alert(1)/>");
    const res = await raw(appOf(), path);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(RAW_CSP);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("never serves html as a page: an octet-stream attachment", async () => {
    const path = bed.file(join(bed.repo, "a.html"), "<script>alert(1)</script>");
    const res = await raw(appOf(), path);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="a.html"; filename*=UTF-8''a.html`,
    );
    expect(res.headers.get("content-security-policy")).toBe(RAW_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("downloads an image on request", async () => {
    const path = bed.file(join(bed.repo, "a.png"), "PNGDATA");
    const res = await raw(appOf(), path, "&download=1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="a\.png"/);
  });

  it("downloads an image larger than 20 MiB", async () => {
    const path = bed.file(join(bed.repo, "big.png"), "");
    truncateSync(path, MAX_INLINE_BYTES + 1);
    const res = await raw(appOf(), path);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    await res.body?.cancel();
  });

  it("serves a dotfile under a safe name and an empty file with no body", async () => {
    const env = bed.file(join(bed.repo, ".env"), "");
    const res = await raw(appOf(), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="_env"; filename*=UTF-8''_env`);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
  });

  it("sends exactly the announced length when the file grows after the open", async () => {
    const path = bed.file(join(bed.repo, "app.log"), "0123456789");
    const real = realService();
    const growing: FilesService = {
      ...real,
      openRaw: async (caller, target) => {
        const opened = await real.openRaw(caller, target);
        appendFileSync(path, "x".repeat(1024));
        return opened;
      },
    };
    const res = await raw(appOf(growing), path);
    expect(res.headers.get("content-length")).toBe("10");
    expect(await res.text()).toBe("0123456789");
  });

  it("answers 404 for a FIFO and completes", async () => {
    const path = join(bed.repo, "pipe.png");
    bed.fifo(path);
    const res = await raw(appOf(), path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("answers 404 to a relative path, a dot-dot spelling, an encoded dot-dot, a NUL, no path and a folder", async () => {
    const app = appOf();
    bed.file(join(bed.repo, "x.png"));
    for (const url of [
      `/files/raw?path=root/../x`,
      `/files/raw?path=%2e%2e`,
      `/files/raw?path=${encodeURIComponent(`${bed.repo}/src/../x.png`)}`,
      `/files/raw?path=${encodeURIComponent(`${bed.repo}/x.png`)}%00`,
      `/files/raw`,
      `/files/raw?path=${encodeURIComponent(bed.repo)}`,
    ]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(404);
      expect(await res.json(), url).toEqual({ error: { code: "not_found" } });
    }
  });

  it("answers 404 and no byte for a hard link to pap's database", async () => {
    writeFileSync(join(bed.bb.papHome, "state.db"), "SECRET-DB");
    const alias = join(bed.repo, "alias.png");
    linkSync(join(bed.bb.papHome, "state.db"), alias);
    const res = await raw(appOf(), alias);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
  });

  it("answers the caller's refusal as it is", async () => {
    const path = bed.file(join(bed.repo, "a.png"));
    const refuse: HttpCaller = (c) => c.json({ error: { code: "unauthenticated" } }, 401);
    const res = await raw(appOf(realService(), refuse), path);
    expect(res.status).toBe(401);
  });

  it("judges against the caller's own roots", async () => {
    const path = bed.file(join(bed.repo, "a.png"));
    const stranger = createFilesService({
      isMember: () => false,
      roots: () => [],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      workerUmask: 0o022,
    });
    expect((await raw(appOf(stranger), path)).status).toBe(404);
  });
});

describe("HEAD and other paths", () => {
  it("answers HEAD with the headers only", async () => {
    const path = bed.file(join(bed.repo, "a.png"), "PNGDATA");
    const res = await raw(appOf(), path, "", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("content-security-policy")).toBe(RAW_CSP);
    expect(await res.text()).toBe("");
  });

  it("keeps the 404 JSON for other paths under /files", async () => {
    const res = await appOf().request("/files/other");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });
});

describe("GET /files/raw under /agents/<id>", () => {
  const AGENT = "helper-1a2b";
  const path = `/agents/${AGENT}/home/a.png`;
  const agentService = (
    stopped = false,
  ): { service: FilesService; ops: ReturnType<typeof createFakeBoxOps> } => {
    const ops = createFakeBoxOps({
      "fs.get": () => {
        if (stopped) throw new PapError("box_stopped");
        return { data: Buffer.from("PNG").toString("base64"), size: 3, nextOffset: null };
      },
    });
    const service = createFilesService({
      isMember: () => false,
      roots: () => [bed.repo],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      workerUmask: 0o022,
      boxes: () => createFakeProjectBoxSource({}),
      boxOps: () => createFakeBoxOps(),
      agentOps: () => ops,
      agents: () => ({
        guestRootOf: (owner, id) => (owner === "u1" && id === AGENT ? "/tmp/vm/helper-1a2b" : null),
        importedOf: () => [],
      }),
    });
    return { service, ops };
  };

  it("serves the owner's agent file through the guest", async () => {
    const { service } = agentService();
    const res = await raw(
      appOf(service, () => testCaller({ userId: "u1" })),
      path,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNG");
  });

  it("answers 404 for a token and for another user's agent, without asking the guest", async () => {
    const { service, ops } = agentService();
    const token = await raw(
      appOf(service, () => testCaller({ kind: "token", userId: "u1" })),
      path,
    );
    expect(token.status).toBe(404);
    const other = await raw(
      appOf(service, () => testCaller({ userId: "u2" })),
      path,
    );
    expect(other.status).toBe(404);
    expect(ops.all).toHaveLength(0);
  });

  it("answers 409 box_stopped for a stopped VM, as a project box does", async () => {
    const { service } = agentService(true);
    const res = await raw(
      appOf(service, () => testCaller({ userId: "u1" })),
      path,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "box_stopped" } });
  });
});
