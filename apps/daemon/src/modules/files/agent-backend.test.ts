import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PapError, type FileMeta } from "@pap/contracts";
import type { AgentFilesSource } from "../../kernel/agent-path.ts";
import { createFakeBoxOps, createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createClientPathGate } from "../../kernel/ws/client-path-gate.ts";
import { testCaller } from "../../testing/caller.ts";
import { createFilesService, type FilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";
import type { UploadService } from "./upload.ts";

/** Every call into the host file system of the code under test is counted: an `/agents` path makes none (R2). */
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
  fsCalls.count = 0;
});
afterEach(() => bed.dispose());

const AGENT = "helper-1a2b";
const OTHER = "other-3c4d";
const GUEST = "/tmp/vm/helper-1a2b";
const ROOT = `/agents/${AGENT}`;
const IMPORTED = [".kube/config", "notes/secret.txt"];
const agents: AgentFilesSource = {
  guestRootOf: (owner, id) => (owner === "u1" && id === AGENT ? GUEST : null),
  importedOf: (id) => (id === AGENT ? IMPORTED : []),
};
const meta = (path: string): FileMeta => ({
  path,
  size: 5,
  mtimeMs: 1,
  etag: "a".repeat(32),
  binary: false,
  editable: true,
  protection: "none",
});
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
const code = async (run: Promise<unknown>) =>
  ((await run.catch((e: unknown) => e)) as { code?: string }).code;

function guestOps() {
  return createFakeBoxOps({
    "fs.list": () => ({
      entries: [entry("config"), entry("cache"), entry("notes")],
      truncated: false,
    }),
    "fs.read": (op) => ({ meta: meta(op.path), text: "hi", offset: 0, nextOffset: null }),
    "fs.write": () => ({ etag: "b".repeat(32) }),
    "fs.put": () => ({ done: true, skipped: false }),
    "fs.get": () => ({ data: Buffer.from("raw").toString("base64"), size: 3, nextOffset: null }),
    "fs.search": () => ({
      paths: ["home/a.txt", "home/.kube/config", "home/notes/secret.txt", "home/notes/ok.txt"],
      truncated: false,
    }),
  });
}

function serviceOf(
  agentOps: ReturnType<typeof guestOps>,
  over: { agents?: AgentFilesSource | undefined; isMember?: (id: string) => boolean } = {},
): FilesService & UploadService {
  return createFilesService({
    isMember: over.isMember ?? (() => false),
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
    agentOps: () => agentOps,
    agents: () => ("agents" in over ? over.agents : agents),
  });
}
const upload = (path: string) => ({
  path,
  conflict: "replace" as const,
  confirmProtected: false,
  chunks: (async function* () {
    yield Buffer.from("x");
  })(),
});

describe("an agent's files", () => {
  it("lists under the guest's root and drops an imported credential from the listing", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const caller = testCaller({ userId: "u1" });
    const kube = await files.list(caller, { path: `${ROOT}/home/.kube` });
    expect(kube.entries.map((e) => e.name)).toEqual(["cache", "notes"]);
    const notes = await files.list(caller, { path: `${ROOT}/home/notes` });
    expect(notes.entries.map((e) => e.name)).toEqual(["config", "cache", "notes"]);
    expect(ops.calls[0]).toMatchObject({
      projectId: AGENT,
      op: { name: "fs.list", path: `${GUEST}/home/.kube` },
    });
    expect(fsCalls.count).toBe(0);
  });

  it("marks a home dot-entry as confirm on write and never leaks the guest root", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const caller = testCaller({ userId: "u1" });
    await expect(
      files.write(caller, { path: `${ROOT}/home/.bashrc`, text: "x", baseEtag: null }),
    ).rejects.toMatchObject({ code: "protected_path" });
    const saved = await files.write(caller, {
      path: `${ROOT}/home/.bashrc`,
      text: "x",
      baseEtag: null,
      confirmProtected: true,
    });
    expect(saved.meta).toMatchObject({ path: `${ROOT}/home/.bashrc`, protection: "confirm" });
    expect(ops.calls.at(-1)?.op).toMatchObject({ name: "fs.write", path: `${GUEST}/home/.bashrc` });
    const plain = await files.write(caller, { path: `${ROOT}/home/a.txt`, text: "x", baseEtag: null });
    expect(plain.meta.protection).toBe("none");
  });

  it("answers meta.path in pap form", async () => {
    const files = serviceOf(guestOps());
    const read = await files.read(testCaller({ userId: "u1" }), { path: `${ROOT}/home/a.txt`, offset: 2 });
    expect(read.meta.path).toBe(`${ROOT}/home/a.txt`);
    expect(JSON.stringify(read)).not.toContain(GUEST);
  });

  it("refuses an imported path on read, raw, write and upload without calling the guest", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const caller = testCaller({ userId: "u1" });
    const secret = `${ROOT}/home/.kube/config`;
    expect(await code(files.read(caller, { path: secret }))).toBe("not_found");
    expect(await code(files.openBoxRaw(caller, secret))).toBe("not_found");
    expect(await code(files.write(caller, { path: secret, text: "x", baseEtag: null }))).toBe("not_found");
    expect(await code(files.upload(caller, upload(secret)))).toBe("not_found");
    expect(ops.all).toHaveLength(0);
    // The sibling of an imported path is not hidden.
    await files.read(caller, { path: `${ROOT}/home/.kube/cache` });
    expect(ops.all).toHaveLength(1);
  });

  it("refuses every method when the imported set cannot be read, never an unfiltered answer", async () => {
    const ops = guestOps();
    const files = serviceOf(ops, {
      agents: {
        guestRootOf: agents.guestRootOf,
        importedOf: () => {
          throw new PapError("internal");
        },
      },
    });
    const caller = testCaller({ userId: "u1" });
    const path = `${ROOT}/home/a.txt`;
    expect(await code(files.list(caller, { path: `${ROOT}/home` }))).toBe("internal");
    expect(await code(files.read(caller, { path }))).toBe("internal");
    expect(await code(files.openBoxRaw(caller, path))).toBe("internal");
    expect(await code(files.write(caller, { path, text: "x", baseEtag: null }))).toBe("internal");
    expect(await code(files.upload(caller, upload(path)))).toBe("internal");
    expect(await code(files.search(caller, { root: ROOT, query: "a" }))).toBe("internal");
    expect(ops.all).toHaveLength(0);
  });

  it("refuses an upload whose sanitized name lands on an imported path", async () => {
    const ops = guestOps();
    const accented = "caf\u00e9.txt";
    const files = serviceOf(ops, {
      agents: { guestRootOf: agents.guestRootOf, importedOf: () => [`notes/${accented}`] },
    });
    const decomposed = "cafe\u0301.txt";
    expect(decomposed).not.toBe(accented);
    expect(
      await code(files.upload(testCaller({ userId: "u1" }), upload(`${ROOT}/home/notes/${decomposed}`))),
    ).toBe("not_found");
    expect(ops.all).toHaveLength(0);
  });

  it("searches without the imported paths", async () => {
    const files = serviceOf(guestOps());
    const found = await files.search(testCaller({ userId: "u1" }), { root: ROOT, query: "a" });
    expect(found.paths).toEqual(["home/a.txt", "home/notes/ok.txt"]);
    expect(await code(files.search(testCaller({ userId: "u1" }), { root: `${ROOT}/home`, query: "a" }))).toBe(
      "not_found",
    );
  });

  it("uploads and streams a raw read through the guest, in guest form", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const caller = testCaller({ userId: "u1" });
    const done = await files.upload(caller, upload(`${ROOT}/home/up.txt`));
    expect(done).toMatchObject({ written: true, meta: { path: `${ROOT}/home/up.txt` } });
    expect(ops.calls[0]?.op).toMatchObject({ name: "fs.put", path: `${GUEST}/home/up.txt` });
    const raw = await files.openBoxRaw(caller, `${ROOT}/home/up.txt`);
    expect(raw?.size).toBe(3);
    expect(ops.calls.at(-1)?.op).toMatchObject({ name: "fs.get", path: `${GUEST}/home/up.txt` });
  });

  it("refuses a token on every method, without calling the guest", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const token = testCaller({ kind: "token", userId: "u1" });
    const path = `${ROOT}/home/a.txt`;
    expect(await code(files.list(token, { path: `${ROOT}/home` }))).toBe("not_found");
    expect(await code(files.read(token, { path }))).toBe("not_found");
    expect(await code(files.write(token, { path, text: "x", baseEtag: null }))).toBe("not_found");
    expect(await code(files.search(token, { root: ROOT, query: "a" }))).toBe("not_found");
    expect(await code(files.upload(token, upload(path)))).toBe("not_found");
    expect(await code(files.openBoxRaw(token, path))).toBe("not_found");
    expect(ops.all).toHaveLength(0);
  });

  it("refuses another user's agent, an unknown id and an unbound source", async () => {
    const ops = guestOps();
    const files = serviceOf(ops);
    const caller = testCaller({ userId: "u1" });
    expect(await code(files.list(caller, { path: `/agents/${OTHER}/home` }))).toBe("not_found");
    expect(await code(files.list(testCaller({ userId: "u2" }), { path: `${ROOT}/home` }))).toBe("not_found");
    const unbound = serviceOf(ops, { agents: undefined });
    expect(await code(unbound.list(caller, { path: `${ROOT}/home` }))).toBe("not_found");
    expect(ops.all).toHaveLength(0);
  });

  it("never lets a path under /agents reach the host (R2)", async () => {
    const files = serviceOf(guestOps());
    const caller = testCaller({ userId: "u1" });
    fsCalls.count = 0;
    for (const path of [
      "/agents",
      "/agents/",
      "/agents//x",
      `${ROOT}/../x`,
      "/agents/Bad_Id/x",
      `/agents/${OTHER}`,
    ]) {
      expect(await code(files.list(caller, { path })), path).toBe("not_found");
      expect(await code(files.read(caller, { path })), path).toBe("not_found");
      expect(await code(files.write(caller, { path, text: "x", baseEtag: null })), path).toBe("not_found");
      expect(await code(files.search(caller, { root: path, query: "a" })), path).toBe("not_found");
      expect(await code(files.upload(caller, upload(path))), path).toBe("not_found");
      expect(await code(files.openBoxRaw(caller, path)), path).toBe("not_found");
    }
    expect(fsCalls.count).toBe(0);
  });

  it("answers box_stopped from a stopped VM", async () => {
    const ops = createFakeBoxOps({
      "fs.list": () => {
        throw new PapError("box_stopped");
      },
    });
    const files = serviceOf(ops as ReturnType<typeof guestOps>);
    expect(await code(files.list(testCaller({ userId: "u1" }), { path: ROOT }))).toBe("box_stopped");
    expect(ops.calls[0]?.op).toMatchObject({ path: GUEST });
  });

  it("a member reaches only their own agents, and the host stays closed", async () => {
    const ops = guestOps();
    const files = serviceOf(ops, { isMember: (id) => id === "u1" });
    const member = testCaller({ userId: "u1" });
    expect((await files.list(member, { path: `${ROOT}/home` })).entries.length).toBe(3);
    expect(await code(files.list(member, { path: `/agents/${OTHER}/home` }))).toBe("not_found");
    expect(await code(files.list(member, { path: bed.repo }))).toBe("forbidden");
    expect(fsCalls.count).toBe(0);
  });
});

describe("the member gate", () => {
  const gate = createClientPathGate({
    isMember: (id) => id === "u1",
    boxes: () => createFakeProjectBoxSource({}),
    agents: () => agents,
  });
  it("allows a member's own agent path and refuses another's, the host and /agents itself", () => {
    expect(gate.allows("u1", [`${ROOT}/home/x`], "files")).toBe(true);
    expect(gate.allows("u1", [ROOT], "files")).toBe(true);
    expect(gate.allows("u1", [ROOT])).toBe(false);
    expect(gate.allows("u1", [`/agents/${OTHER}/home`], "files")).toBe(false);
    expect(gate.allows("u1", ["/agents"], "files")).toBe(false);
    expect(gate.allows("u1", [`${ROOT}/../x`], "files")).toBe(false);
    expect(gate.allows("u1", [bed.repo])).toBe(false);
    expect(gate.allows("u2", [`${ROOT}/home`])).toBe(true);
  });
  it("refuses every agent path when no source is bound", () => {
    const none = createClientPathGate({ isMember: () => true, boxes: () => undefined });
    expect(none.allows("u1", [`${ROOT}/home`])).toBe(false);
  });
});
