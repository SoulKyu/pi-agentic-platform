import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_CHUNK_BYTES, PapError, type BoxOpValue, type FileMeta } from "@pap/contracts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { createFakeBoxOps, createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { testCaller } from "../../testing/caller.ts";
import { mountRawRoute } from "./raw-http.ts";
import { createFilesService, type FilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import { mountUploadRoute } from "./upload-http.ts";
import type { UploadService } from "./upload.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const ROOT = `/boxes/${PROJECT}/project`;
const meta = (path: string): FileMeta => ({
  path,
  size: 5,
  mtimeMs: 1,
  etag: "a".repeat(32),
  binary: false,
  editable: true,
  protection: "none",
});
const source = (root = ROOT) =>
  createFakeProjectBoxSource({
    [PROJECT]: {
      ownerId: "u1",
      root,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: false,
    },
  });
const neverGit = new Proxy(
  {},
  {
    get() {
      throw new Error("host git was called");
    },
  },
) as GitRunner;

function serviceOf(
  ops: ReturnType<typeof createFakeBoxOps>,
  over: { root?: string; git?: GitRunner; roots?: string[] } = {},
): FilesService & UploadService {
  return createFilesService({
    isMember: () => false,
    roots: () => over.roots ?? [bed.repo],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: over.git ?? bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
    boxes: () => source(over.root),
    boxOps: () => ops,
  });
}
const code = async (run: Promise<unknown>) =>
  ((await run.catch((e: unknown) => e)) as { code?: string }).code;
const file = `${ROOT}/a.txt`;

describe("a box project's files", () => {
  it("lists, reads and writes through the box", async () => {
    const ops = createFakeBoxOps({
      "fs.list": () => ({ entries: [], truncated: false }) as BoxOpValue<"fs.list">,
      "fs.read": (op) => ({ meta: meta(op.path), text: "hi", offset: 0, nextOffset: null }),
      "fs.write": () => ({ etag: "b".repeat(32) }),
      "fs.search": () => ({ paths: ["a.txt", ".mcp.json"], truncated: false }),
    });
    const files = serviceOf(ops);
    const caller = testCaller();
    await files.list(caller, { path: ROOT, showIgnored: true });
    expect((await files.read(caller, { path: file, offset: 3 })).text).toBe("hi");
    const written = await files.write(caller, { path: file, text: "héllo", baseEtag: null });
    expect(written.meta).toMatchObject({ size: 6, etag: "b".repeat(32), protection: "none" });
    expect(await files.search(caller, { root: ROOT, query: "a" })).toEqual({
      paths: ["a.txt", ".mcp.json"],
      truncated: false,
    });
    expect(await code(files.search(caller, { root: `${ROOT}/src`, query: "a" }))).toBe("not_found");
    expect(ops.calls.map((c) => c.op.name)).toEqual(["fs.list", "fs.read", "fs.write", "fs.search"]);
    expect(ops.calls[1]?.op).toMatchObject({ offset: 3 });
    expect(ops.calls[0]?.projectId).toBe(PROJECT);
  });

  it("a token never sees the names the boundary hides, and a stopped box answers box_stopped", async () => {
    const stopped = createFakeBoxOps({
      "fs.read": () => {
        throw new PapError("box_stopped");
      },
      "fs.search": () => ({ paths: ["a.txt", ".mcp.json"], truncated: false }),
    });
    const files = serviceOf(stopped);
    expect(await code(files.read(testCaller(), { path: file }))).toBe("box_stopped");
    const token = testCaller({ kind: "token" });
    expect(await code(files.read(token, { path: `${ROOT}/.mcp.json` }))).toBe("not_found");
    expect((await files.search(token, { root: ROOT, query: "a" })).paths).toEqual(["a.txt"]);
    expect(stopped.calls).toHaveLength(2);
  });

  it("a token reads and searches a project's own dev/, run/, proc/ and sys/ folders (host-only names do not apply)", async () => {
    const ops = createFakeBoxOps({
      "fs.read": (op) => ({ meta: meta(op.path), text: "hi", offset: 0, nextOffset: null }),
      "fs.search": () => ({
        paths: ["dev/main.ts", "run/x", "proc/y", "sys/z", ".mcp.json"],
        truncated: false,
      }),
    });
    const files = serviceOf(ops);
    const token = testCaller({ kind: "token" });
    for (const folder of ["dev", "run", "proc", "sys"])
      expect((await files.read(token, { path: `${ROOT}/${folder}/a.ts` })).text).toBe("hi");
    expect((await files.search(token, { root: ROOT, query: "a" })).paths).toEqual([
      "dev/main.ts",
      "run/x",
      "proc/y",
      "sys/z",
    ]);
    expect(await code(files.read(token, { path: `${ROOT}/dev/.mcp.json` }))).toBe("not_found");
  });

  it("a token's listing marks the names it cannot open as protected", async () => {
    const entry = (name: string) => ({
      name,
      kind: "file" as const,
      size: 1,
      mtimeMs: 1,
      hidden: null,
      protected: false,
      link: null,
      linkDir: false,
    });
    const ops = createFakeBoxOps({
      "fs.list": () => ({ entries: [entry("a.txt"), entry(".mcp.json")], truncated: false }),
    });
    const files = serviceOf(ops);
    const flags = async (caller: ReturnType<typeof testCaller>) =>
      (await files.list(caller, { path: ROOT })).entries.map((e) => [e.name, e.protected]);
    expect(await flags(testCaller({ kind: "token" }))).toEqual([
      ["a.txt", false],
      [".mcp.json", true],
    ]);
    expect(await flags(testCaller())).toEqual([
      ["a.txt", false],
      [".mcp.json", false],
    ]);
  });

  it("a path with dot segments is never routed to a box, even if the source is lax", async () => {
    const ops = createFakeBoxOps({
      "fs.read": (op) => ({ meta: meta(op.path), text: "x", offset: 0, nextOffset: null }),
    });
    const lax = { ...source(), byPath: () => ({ projectId: PROJECT, root: ROOT }) };
    const files = createFilesService({
      isMember: () => false,
      roots: () => [],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      workerUmask: 0o022,
      boxes: () => lax,
      boxOps: () => ops,
    });
    for (const path of [`${ROOT}/../x`, `${ROOT}/./a`, `${ROOT}//a`])
      expect(await code(files.read(testCaller(), { path })), path).toBe("not_found");
    expect(ops.calls).toHaveLength(0);
  });

  it("with no box ops bound a box path answers box_stopped and sends nothing", async () => {
    const files = createFilesService({
      isMember: () => false,
      roots: () => [],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      workerUmask: 0o022,
      boxes: () => source(),
    });
    expect(await code(files.read(testCaller(), { path: file }))).toBe("box_stopped");
  });

  it("a protected path still asks for confirmation", async () => {
    const ops = createFakeBoxOps({ "fs.write": () => ({ etag: "c".repeat(32) }) });
    const files = serviceOf(ops);
    const owner = testCaller();
    const path = `${ROOT}/.husky/pre-commit`;
    expect(await code(files.write(owner, { path, text: "x", baseEtag: null }))).toBe("protected_path");
    expect(await code(files.write(testCaller({ kind: "token" }), { path, text: "x", baseEtag: null }))).toBe(
      "forbidden",
    );
    expect(ops.calls).toHaveLength(0);
    const stepUp = `${ROOT}/.pi/project.yaml`;
    expect(
      await code(files.write(owner, { path: stepUp, text: "x", baseEtag: null, confirmProtected: true })),
    ).toBe("step_up_required");
    const done = await files.write(owner, { path, text: "x", baseEtag: null, confirmProtected: true });
    expect(done.meta.protection).toBe("confirm");
    expect(ops.calls).toHaveLength(1);
  });

  it("the host fs and git helpers never see a box path", async () => {
    // The box root is a real host folder here (the process backend): the guest's answer is the only one.
    const ops = createFakeBoxOps({
      "fs.read": (op) => ({ meta: meta(op.path), text: "guest", offset: 0, nextOffset: null }),
      "fs.list": () => ({ entries: [], truncated: false }),
      "fs.search": () => ({ paths: ["g.txt"], truncated: false }),
      "fs.write": () => ({ etag: "d".repeat(32) }),
    });
    const files = serviceOf(ops, { root: bed.repo, git: neverGit, roots: [bed.repo] });
    const caller = testCaller();
    const path = `${bed.repo}/a.txt`;
    expect((await files.read(caller, { path })).text).toBe("guest");
    await files.list(caller, { path: bed.repo });
    expect((await files.search(caller, { root: bed.repo, query: "g" })).paths).toEqual(["g.txt"]);
    await files.write(caller, { path, text: "x", baseEtag: null });
    expect(ops.calls).toHaveLength(4);
    const other = testCaller({ userId: "u2" });
    expect(await code(files.read(other, { path: `${ROOT}/a.txt` }))).toBe("not_found");
  });

  it("a box-path upload never calls the host fs or git", async () => {
    const ops = createFakeBoxOps({ "fs.put": (op) => ({ done: op.last, skipped: false }) });
    const files = serviceOf(ops, { root: bed.repo, git: neverGit, roots: [bed.repo] });
    const app = createHttpApp({
      allowedOrigins: new Set(["http://localhost:7777"]),
      staticRoot: null,
      logger: bed.logger,
      mount: (hono) =>
        mountUploadRoute(hono, { caller: () => testCaller(), service: files, logger: bed.logger }),
      wsProbe: (c) => c.text("no"),
    });
    const target = `${bed.repo}/guest-only.txt`;
    const res = await app.request(`/files/raw?path=${encodeURIComponent(target)}&conflict=replace`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3", origin: "http://localhost:7777" },
    });
    expect(res.status).toBe(200);
    expect(ops.calls).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });
});

const ORIGIN = "http://localhost:7777";
const appOf = (service: FilesService & UploadService) =>
  createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (hono) => {
      mountRawRoute(hono, { caller: () => testCaller(), service, logger: bed.logger });
      mountUploadRoute(hono, { caller: () => testCaller(), service, logger: bed.logger });
    },
    wsProbe: (c) => c.text("no"),
  });
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("the raw routes of a box project", () => {
  it("raw download streams the guest's chunks", async () => {
    const chunks = ["hello ", "box"];
    const ops = createFakeBoxOps({
      "fs.get": (op) => {
        const index = op.offset === 0 ? 0 : 1;
        return {
          data: b64(chunks[index] ?? ""),
          size: 9,
          nextOffset: index === 0 ? 6 : null,
        };
      },
    });
    const res = await appOf(serviceOf(ops)).request(`/files/raw?path=${encodeURIComponent(file)}&download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("9");
    expect(res.headers.get("content-disposition")).toContain("a.txt");
    expect(await res.text()).toBe("hello box");
    expect(ops.calls.map((c) => (c.op as { offset: number }).offset)).toEqual([0, 6]);
  });

  it("a stopped box answers 409 box_stopped on both routes", async () => {
    const ops = createFakeBoxOps({
      "fs.get": () => {
        throw new PapError("box_stopped");
      },
      "fs.put": () => {
        throw new PapError("box_stopped");
      },
    });
    const app = appOf(serviceOf(ops));
    const got = await app.request(`/files/raw?path=${encodeURIComponent(file)}`);
    expect(got.status).toBe(409);
    expect(await got.json()).toEqual({ error: { code: "box_stopped" } });
    const put = await app.request(`/files/raw?path=${encodeURIComponent(file)}&conflict=replace`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3", origin: ORIGIN },
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: { code: "box_stopped" } });
  });

  it("upload goes chunk by chunk, the last one flagged, and honours conflict skip", async () => {
    const seen: Array<{ offset: number; bytes: number; last: boolean }> = [];
    const ops = createFakeBoxOps({
      "fs.put": (op) => {
        seen.push({ offset: op.offset, bytes: Buffer.from(op.data, "base64").length, last: op.last });
        return { done: op.last, skipped: false };
      },
    });
    const size = FILE_CHUNK_BYTES * 2 + 5;
    const res = await appOf(serviceOf(ops)).request(
      `/files/raw?path=${encodeURIComponent(file)}&conflict=replace`,
      {
        method: "PUT",
        body: Buffer.alloc(size, 1),
        headers: { "content-length": String(size), origin: ORIGIN },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: true, meta: { size, path: file } });
    expect(seen).toEqual([
      { offset: 0, bytes: FILE_CHUNK_BYTES, last: false },
      { offset: FILE_CHUNK_BYTES, bytes: FILE_CHUNK_BYTES, last: false },
      { offset: FILE_CHUNK_BYTES * 2, bytes: 5, last: true },
    ]);

    const skipping = createFakeBoxOps({ "fs.put": () => ({ done: true, skipped: true }) });
    const skipped = await appOf(serviceOf(skipping)).request(
      `/files/raw?path=${encodeURIComponent(file)}&conflict=skip`,
      { method: "PUT", body: "abc", headers: { "content-length": "3", origin: ORIGIN } },
    );
    expect(await skipped.json()).toEqual({ written: false });
    expect(skipping.calls).toHaveLength(1);
  });
});
