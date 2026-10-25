import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import { testCaller } from "../../testing/caller.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import type { UploadService } from "./upload.ts";
import { mountUploadRoute } from "./upload-http.ts";

type UploadBody = string | Buffer | ReadableStream<Uint8Array>;
const ORIGIN = "http://localhost:7777";
let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const serviceOf = (readOnly = false): UploadService =>
  createFilesService({
    isMember: () => false,
    roots: () => [bed.repo],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly,
    workerUmask: 0o022,
  });
const owner: HttpCaller = () => testCaller();

function appOf(service: UploadService = serviceOf(), caller: HttpCaller = owner): Hono {
  return createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (hono) => mountUploadRoute(hono, { caller, service, logger: bed.logger }),
    wsProbe: (c) => c.text("no"),
  });
}

const put = (
  app: Hono,
  path: string,
  body: UploadBody | null,
  extra = "",
  headers: Record<string, string> = {},
) => {
  const length = typeof body === "string" ? String(Buffer.byteLength(body)) : undefined;
  return app.request(`/files/raw?path=${encodeURIComponent(path)}${extra}`, {
    method: "PUT",
    body,
    headers: { origin: ORIGIN, ...(length === undefined ? {} : { "content-length": length }), ...headers },
    duplex: "half",
  } as RequestInit);
};
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
const temps = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const modeOf = (path: string): number => statSync(path).mode & 0o7777;

describe("PUT /files/raw", () => {
  it("creates a file with the worker umask mode and answers its meta", async () => {
    const path = join(bed.repo, "up.txt");
    const res = await put(appOf(), path, "héllo", "&conflict=skip");
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { written: boolean; meta: Record<string, unknown> };
    expect(answer.written).toBe(true);
    expect(answer.meta).toMatchObject({ path, size: Buffer.byteLength("héllo"), protection: "none" });
    expect(readFileSync(path, "utf8")).toBe("héllo");
    expect(modeOf(path)).toBe(0o644);
    expect(temps(bed.repo)).toEqual([]);
  });

  it("answers 400 to a name with a bidi control, and writes nothing", async () => {
    const path = join(bed.repo, "a‮b.txt");
    const before = readdirSync(bed.repo);
    const res = await put(appOf(), path, "x", "&conflict=replace");
    expect(res.status).toBe(400);
    expect(readdirSync(bed.repo)).toEqual(before);
  });

  it("answers 400 to a Default_Ignorable name (MC9) and to a missing or unknown conflict", async () => {
    const hangul = await put(appOf(), join(bed.repo, "aㅤb.txt"), "x", "&conflict=skip");
    expect(hangul.status).toBe(400);
    const variation = await put(appOf(), join(bed.repo, "a️b.txt"), "x", "&conflict=skip");
    expect(variation.status).toBe(400);
    expect((await put(appOf(), join(bed.repo, "c.txt"), "x")).status).toBe(400);
    expect((await put(appOf(), join(bed.repo, "c.txt"), "x", "&conflict=merge")).status).toBe(400);
  });

  it("answers 409 protected_path under .git/hooks, then writes with confirmProtected", async () => {
    const path = join(bed.repo, ".git", "hooks", "pre-commit");
    mkdirSync(join(bed.repo, ".git", "hooks"), { recursive: true });
    const refused = await put(appOf(), path, "#!/bin/sh\n", "&conflict=skip");
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("protected_path");
    expect(readdirSync(join(bed.repo, ".git", "hooks"))).not.toContain("pre-commit");
    const ok = await put(appOf(), path, "#!/bin/sh\n", "&conflict=skip&confirmProtected=1");
    expect(ok.status).toBe(200);
    expect(modeOf(path)).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\n");
  });

  it("answers 403 step_up_required under .pi/ without a live step-up, and writes nothing", async () => {
    mkdirSync(join(bed.repo, ".pi"), { recursive: true });
    const path = join(bed.repo, ".pi", "x.md");
    const res = await put(appOf(), path, "x", "&conflict=skip&confirmProtected=1");
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("step_up_required");
    expect(readdirSync(join(bed.repo, ".pi"))).toEqual([]);
    const live: HttpCaller = () => testCaller({ stepUpUntil: bed.clock.now() + 60_000 });
    expect((await put(appOf(serviceOf(), live), path, "x", "&conflict=skip&confirmProtected=1")).status).toBe(
      200,
    );
  });

  it("skips an existing file and replaces it on request", async () => {
    const path = join(bed.repo, "a.txt");
    const before = readFileSync(path, "utf8");
    const skipped = await put(appOf(), path, "new", "&conflict=skip");
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ written: false });
    expect(readFileSync(path, "utf8")).toBe(before);
    const replaced = await put(appOf(), path, "new", "&conflict=replace");
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { written: boolean }).written).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(temps(bed.repo)).toEqual([]);
  });

  it("keeps the mode of the file it replaces", async () => {
    const path = join(bed.repo, "run.sh");
    writeFileSync(path, "old", { mode: 0o755 });
    await put(appOf(), path, "new", "&conflict=replace");
    expect(modeOf(path)).toBe(0o755);
  });

  it("answers 404 to a target in the pap home", async () => {
    const path = join(bed.bb.papHome, "x.txt");
    const res = await put(appOf(), path, "x", "&conflict=replace");
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("not_found");
  });

  it("answers 413 above 25 MiB and 400 without a length, before any judgement", async () => {
    const path = join(bed.repo, "big.bin");
    const big = await put(appOf(), path, null, "&conflict=skip", { "content-length": "26214401" });
    expect(big.status).toBe(413);
    // The header is on the returned Response, so a refused body is not drained (MC38 m8).
    expect(big.headers.get("connection")).toBe("close");
    const none = await put(appOf(), path, null, "&conflict=skip");
    expect(none.status).toBe(400);
    expect(none.headers.get("connection")).toBe("close");
    expect(readdirSync(bed.repo)).not.toContain("big.bin");
  });

  it("answers 413 and keeps nothing when the body is longer than announced", async () => {
    const path = join(bed.repo, "long.bin");
    const res = await put(appOf(), path, Buffer.alloc(10, 1), "&conflict=skip", {
      "content-length": "5",
    });
    expect(res.status).toBe(413);
    expect(readdirSync(bed.repo)).not.toContain("long.bin");
    expect(temps(bed.repo)).toEqual([]);
  });

  it("answers 503 read_only without pulling the body", async () => {
    let pulled = 0;
    // highWaterMark 0: nothing is pulled until a reader asks.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await put(appOf(serviceOf(true)), join(bed.repo, "r.txt"), body, "&conflict=skip", {
      "content-length": "3",
    });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("read_only");
    expect(pulled).toBe(0);
    // Read-only comes first: before the length is looked at.
    const bare = await put(appOf(serviceOf(true)), join(bed.repo, "r.txt"), null, "&conflict=skip");
    expect(bare.status).toBe(503);
  });

  it("never pulls the body of an upload the name, the boundary or the write gate refuses", async () => {
    mkdirSync(join(bed.repo, ".pi"), { recursive: true });
    const cases: Array<[string, string, number]> = [
      [join(bed.repo, "a\u202Eb.txt"), "&conflict=skip", 400],
      [join(bed.bb.papHome, "x.txt"), "&conflict=skip", 404],
      [join(bed.repo, ".pi", "x.md"), "&conflict=skip&confirmProtected=1", 403],
      [join(bed.repo, ".git", "hooks", "x"), "&conflict=skip", 409],
    ];
    for (const [path, extra, status] of cases) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled++;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const res = await put(appOf(), path, body, extra, { "content-length": "3" });
      expect(res.status, path).toBe(status);
      expect(pulled, path).toBe(0);
    }
  });

  it("refuses the fifth concurrent upload of one owner before reading its body, and frees the slots", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    let pulls = 0;
    const open = () =>
      new ReadableStream<Uint8Array>(
        {
          start: (controller) => void controllers.push(controller),
          pull: () => void pulls++,
        },
        { highWaterMark: 0 },
      );
    const app = appOf();
    const headers = { "content-length": "2" };
    const first = Array.from({ length: 4 }, (_, i) =>
      put(app, join(bed.repo, `c${i}.txt`), open(), "&conflict=skip", headers),
    );
    await vi.waitFor(() => expect(pulls).toBe(4), { timeout: 5_000 });
    const pullsBefore = pulls;
    const fifth = await put(app, join(bed.repo, "c4.txt"), open(), "&conflict=skip", headers);
    expect(fifth.status).toBe(503);
    expect(await codeOf(fifth)).toBe("capacity");
    expect(pulls).toBe(pullsBefore);
    for (const controller of controllers.slice(0, 4)) {
      controller.enqueue(new Uint8Array([104, 105]));
      controller.close();
    }
    expect((await Promise.all(first)).map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect((await put(app, join(bed.repo, "c5.txt"), "hi", "&conflict=skip")).status).toBe(200);
  });

  it("frees the slot when the upload is refused", async () => {
    const app = appOf();
    const path = join(bed.bb.papHome, "x.txt");
    for (let i = 0; i < 6; i++) expect((await put(app, path, "x", "&conflict=skip")).status).toBe(404);
    expect((await put(app, join(bed.repo, "after.txt"), "x", "&conflict=skip")).status).toBe(200);
  });

  it("is refused without an Origin by the app's guard", async () => {
    const res = await appOf().request(
      `/files/raw?path=${encodeURIComponent(join(bed.repo, "o.txt"))}&conflict=skip`,
      {
        method: "PUT",
        body: "x",
        headers: { "content-length": "1" },
      },
    );
    expect(res.status).toBe(403);
    expect(readdirSync(bed.repo)).not.toContain("o.txt");
  });

  it("returns the caller's refusal as is", async () => {
    const refuse: HttpCaller = (c) => c.json({ error: { code: "unauthenticated" } }, 401);
    expect(
      (await put(appOf(serviceOf(), refuse), join(bed.repo, "u.txt"), "x", "&conflict=skip")).status,
    ).toBe(401);
  });
});
