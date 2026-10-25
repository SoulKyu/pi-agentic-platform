import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { boxCwdOf, newBoxCwdOf } from "./box-cwd.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ROOT = "/boxes/p1/project";
const source = createFakeProjectBoxSource({
  p1: {
    ownerId: "u1",
    root: ROOT,
    resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
    hosts: [],
    deleting: false,
  },
});
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("a session cwd under a box root", () => {
  it("never calls realpath: the spelling given is the spelling kept", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-box-cwd-"));
    mkdirSync(join(dir, "real"));
    const link = join(dir, "link");
    symlinkSync(join(dir, "real"), link);
    const linked = createFakeProjectBoxSource({
      p1: {
        ownerId: "u1",
        root: link,
        resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
        hosts: [],
        deleting: false,
      },
    });
    const sub = `${link}/sub`;
    expect(boxCwdOf(linked, "u1", link)).toEqual({ projectId: "p1", cwd: link });
    expect(boxCwdOf(linked, "u1", sub)).toEqual({ projectId: "p1", cwd: sub });
    expect(resolveSessionCwd(link)).not.toBe(link);
  });

  it("is a session of that project: the row keeps the cwd and the project id", async () => {
    const bed = createServiceBed(
      { createSessionsStore, createSessionsService, loadTranscriptReader },
      { boxes: source },
    );
    try {
      const { sessionId } = await bed.service.create(`${ROOT}/src`, { userId: "u1" } as never);
      expect(bed.store.get(sessionId)?.cwd).toBe(`${ROOT}/src`);
      expect(bed.store.marks.row(sessionId)?.projectId).toBe("p1");
    } finally {
      bed.dispose();
    }
  });

  it("look-alikes fall back to the host path rules", async () => {
    const bed = createServiceBed(
      { createSessionsStore, createSessionsService, loadTranscriptReader },
      { boxes: source },
    );
    try {
      for (const cwd of [
        `${ROOT}/../x`,
        `${ROOT}/./x`,
        `${ROOT}//x`,
        `${ROOT}X`,
        `${ROOT}/`,
        "/boxes/p2/project",
        "/boxes/p1",
      ]) {
        expect(boxCwdOf(source, "u1", cwd)).toBeNull();
        await expect(bed.service.create(cwd, { userId: "u1" } as never)).rejects.toThrow(
          expect.objectContaining({ code: "invalid_cwd" }) as PapError,
        );
      }
      expect(boxCwdOf(source, "u2", ROOT)).toBeNull();
      expect(boxCwdOf(undefined, "u1", ROOT)).toBeNull();
    } finally {
      bed.dispose();
    }
  });
});

describe("new work in a box being deleted", () => {
  const deleting = createFakeProjectBoxSource({
    p1: {
      ownerId: "u1",
      root: ROOT,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: true,
    },
  });

  it("is refused not_found before any row, while reads of the path still find the project", () => {
    expect(() => newBoxCwdOf(deleting, "u1", ROOT, () => false)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(boxCwdOf(deleting, "u1", ROOT)).toEqual({ projectId: "p1", cwd: ROOT });
    expect(newBoxCwdOf(source, "u1", ROOT, () => false)).toEqual({ projectId: "p1", cwd: ROOT });
    expect(newBoxCwdOf(source, "u1", "/elsewhere", () => false)).toBeNull();
  });
});
