import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { httpCaller } from "../../kernel/http/caller.ts";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createClientPathGate } from "../../kernel/ws/client-path-gate.ts";
import { testCaller } from "../../testing/caller.ts";
import { mountRawRoute } from "./raw-http.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import { mountUploadRoute } from "./upload-http.ts";

/** Every call into the host file system of the code under test is counted: a refused member path makes none. */
const fsCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const counted = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            fsCalls.count++;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
  return { ...counted, default: counted };
});

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const BOX = "/boxes/p1/project";
const boxes = createFakeProjectBoxSource({
  p1: {
    ownerId: "m1",
    root: BOX,
    resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
    hosts: [],
    deleting: false,
  },
});
const isMember = (id: string) => id === "m1";
const member = testCaller({ userId: "m1" });

// The host folder is even listed among the member's roots: the gate does not rely on the roots being empty.
const service = () =>
  createFilesService({
    isMember,
    roots: () => [bed.repo],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
    boxes: () => boxes,
  });
const code = async (run: () => unknown) => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("files for a member (M14)", () => {
  it("refuses a host path with zero host file-system calls", async () => {
    const files = service();
    const path = join(bed.repo, "a.txt");
    fsCalls.count = 0;
    expect(await code(() => files.list(member, { path: bed.repo }))).toBe("forbidden");
    expect(await code(() => files.read(member, { path }))).toBe("forbidden");
    expect(await code(() => files.write(member, { path, text: "x", expected: null } as never))).toBe(
      "forbidden",
    );
    expect(await code(() => files.search(member, { root: bed.repo, query: "a" }))).toBe("forbidden");
    expect(await code(() => files.openRaw(member, path))).toBe("forbidden");
    expect(await code(() => files.openBoxRaw(member, path))).toBe("forbidden");
    expect(
      await code(() =>
        files.upload(member, {
          path,
          conflict: "replace",
          confirmProtected: false,
          chunks: (async function* () {})(),
        }),
      ),
    ).toBe("forbidden");
    expect(fsCalls.count).toBe(0);
  });

  it("still answers a box path from the box side, and the owner keeps the host", async () => {
    const files = service();
    // No guest is bound in this bed: reaching `box_stopped` shows the path was routed to the box, not refused or read on the host.
    expect(await code(() => files.list(member, { path: `${BOX}/src` }))).toBe("box_stopped");
    const owner = testCaller({ userId: "u1" });
    fsCalls.count = 0;
    expect((await files.list(owner, { path: bed.repo })).entries.map((e) => e.name)).toContain("a.txt");
    // The counter is live: the owner's host listing makes calls.
    expect(fsCalls.count).toBeGreaterThan(0);
  });
});

describe("the raw file routes for a member (M14)", () => {
  const appOf = (): Hono => {
    const files = service();
    const caller = httpCaller(
      (header) => (header === "pap=m" ? member : null),
      createClientPathGate({ isMember, boxes: () => boxes }),
    );
    return createHttpApp({
      allowedOrigins: new Set(["http://localhost:7777"]),
      staticRoot: null,
      logger: bed.logger,
      mount: (hono) => {
        mountRawRoute(hono, { caller, service: files, logger: bed.logger });
        mountUploadRoute(hono, { caller, service: files, logger: bed.logger });
      },
      wsProbe: (c) => c.text("no"),
    });
  };
  const headers = { cookie: "pap=m", origin: "http://localhost:7777" };

  it("GET and PUT /files/raw refuse a host path with zero fs calls", async () => {
    const app = appOf();
    const path = encodeURIComponent(join(bed.repo, "a.txt"));
    fsCalls.count = 0;
    const got = await app.request(`/files/raw?path=${path}`, { headers });
    expect(got.status).toBe(403);
    const put = await app.request(`/files/raw?path=${path}&conflict=replace`, {
      method: "PUT",
      headers,
      body: "x",
    });
    expect(put.status).toBe(403);
    expect(fsCalls.count).toBe(0);
  });
});
