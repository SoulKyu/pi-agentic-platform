import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry, ResponseFrame } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RAW_CSP } from "../modules/files/raw-http.ts";
import {
  AUTH_KEY,
  type FileBed,
  NOT_FOUND_BODY,
  outcomeOf,
  rawGet,
  rawPost,
  rawPut,
  SECRET_TEXT,
  startFileBed,
} from "./testing/fixtures.ts";
import { type Code, traversalRows } from "./testing/traversal-rows.ts";

// Spec C §8.1, class "path traversal", on every route M8 adds, through the whole daemon (M8R67). Each row is one hostile
// form; each column is a route. The expectations are the matrix of the plan, cell by cell ("—" is an absent cell).
let bed: FileBed;
beforeAll(async () => {
  bed = await startFileBed();
}, 60_000);
afterAll(async () => {
  await bed?.stop();
});

/** The refusal of a row never carries what it guards. */
function expectNoSecrets(text: string, label: string): void {
  for (const secret of [SECRET_TEXT, AUTH_KEY, "SQLite format 3"])
    expect(text, `${label} leaked ${secret}`).not.toContain(secret);
}

function expectRefused(label: string, frame: ResponseFrame, code: Code): void {
  expect([label, outcomeOf(frame)]).toEqual([label, code]);
  expectNoSecrets(JSON.stringify(frame), label);
}

const call = (method: string, params: object): Promise<ResponseFrame> =>
  bed.client.call(method as never, params as never, 8_000);

/** What the hostile writes must have left alone. */
function expectPrivateFilesIntact(): void {
  expect(readFileSync(join(bed.O, "secret.txt"), "utf8")).toBe(SECRET_TEXT);
  expect(readFileSync(join(bed.O, "deep", "secret.txt"), "utf8")).toBe(SECRET_TEXT);
  expect(readFileSync(join(bed.free, "secret.txt"), "utf8")).toBe(SECRET_TEXT);
  expect(readFileSync(join(bed.agentDir, "auth.json"), "utf8")).toBe(JSON.stringify({ key: AUTH_KEY }));
  expect(readFileSync(join(bed.R, "notes.txt"), "utf8")).toBe(JSON.stringify({ key: AUTH_KEY }));
  expect(readFileSync(join(bed.t.home, "state.db")).subarray(0, 15).toString("latin1")).toBe(
    "SQLite format 3",
  );
  expect(readdirSync(bed.O).sort()).toEqual(["deep", "into-dir", "into-r", "secret.txt"]);
  expect(readdirSync(bed.free)).toEqual(["secret.txt"]);
}

const enc = encodeURIComponent;

describe("security: traversal on the files RPC", () => {
  it.each(["files.list", "files.read", "files.write"] as const)(
    "%s refuses every hostile form",
    async (method) => {
      for (const row of traversalRows(bed)) {
        const params =
          method === "files.write"
            ? { path: row.path, text: "OVERWRITTEN", baseEtag: null }
            : { path: row.path };
        expectRefused(`${method} ${row.label}`, await call(method, params), row.rpc);
      }
      expectPrivateFilesIntact();
    },
  );

  it("lists, reads and writes the control file, and lists the hard links as ordinary names", async () => {
    const listed = await call("files.list", { path: bed.R });
    if (!listed.ok) throw new Error("list failed");
    const entries = (listed.result as { entries: FileEntry[] }).entries;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("ok.txt")).toMatchObject({ kind: "file", protected: false });
    expect(byName.get("notes.txt")).toMatchObject({ kind: "file", protected: false });
    expect(byName.get("db.bin")).toMatchObject({ kind: "file", protected: false });
    const read = await call("files.read", { path: join(bed.R, "ok.txt") });
    expect(read).toMatchObject({ ok: true, result: { text: "ok, changed\n" } });
    const written = await call("files.write", {
      path: join(bed.R, "ok-written.txt"),
      text: "written\n",
      baseEtag: null,
    });
    expect(outcomeOf(written)).toBe("ok");
    expect(readFileSync(join(bed.R, "ok-written.txt"), "utf8")).toBe("written\n");
  });

  it("takes a backslash for a name character, never a separator: the file is made inside R and nothing outside", async () => {
    const name = "a\\..\\..\\outside\\secret.txt";
    const path = join(bed.R, name);
    expect(outcomeOf(await call("files.write", { path, text: "inside\n", baseEtag: null }))).toBe("ok");
    expect(readFileSync(join(bed.R, name), "utf8")).toBe("inside\n");
    const raw = await rawGet(bed.t.port, `/files/raw?path=${enc(path)}`, { cookie: bed.cookie });
    expect([raw.status, raw.body]).toEqual([200, "inside\n"]);
    // The upload route refuses a name with a backslash before it looks at the boundary.
    const put = await rawPut(bed.t.port, `/files/raw?path=${enc(path)}&conflict=replace`, bed.browser, "x");
    expect(put.status).toBe(400);
    expectPrivateFilesIntact();
  });

  it("shows the home entry of the folder that holds pap's home as protected, and refuses to list home itself", async () => {
    const listed = await call("files.list", { path: bed.holder });
    if (!listed.ok) throw new Error("list failed");
    const entries = (listed.result as { entries: FileEntry[] }).entries;
    expect(entries.find((entry) => entry.name === "home")).toMatchObject({ kind: "dir", protected: true });
    expectRefused("files.list <t.home>", await call("files.list", { path: bed.t.home }), "not_found");
  });
});

describe("security: traversal on GET /files/raw", () => {
  const get = (path: string) => rawGet(bed.t.port, `/files/raw?path=${enc(path)}`, { cookie: bed.cookie });

  it("answers 404, with no secret, to every hostile form", async () => {
    for (const row of traversalRows(bed)) {
      const reply = await get(row.path);
      expect([row.label, reply.status, reply.body]).toEqual([row.label, 404, NOT_FOUND_BODY]);
      expectNoSecrets(reply.body, row.label);
    }
  });

  it("answers 404 to overlong UTF-8 dots sent as raw bytes in the query", async () => {
    const O = bed.O.split("/").slice(-2).join("/");
    for (const dots of ["%c0%ae%c0%ae", "%2e%2e", "%252e%252e", "%c0%2e%c0%2e"]) {
      const url = `/files/raw?path=${bed.R}/${dots}/${dots}/${O}/secret.txt`;
      const reply = await rawGet(bed.t.port, url, { cookie: bed.cookie });
      expect([dots, reply.status, reply.body]).toEqual([dots, 404, NOT_FOUND_BODY]);
    }
  });

  it("serves the control file, an SVG only in a sandbox, and an HTML file only as a download", async () => {
    expect(await get(join(bed.R, "ok.txt"))).toMatchObject({ status: 200, body: "ok, changed\n" });
    const svg = await get(join(bed.R, "x.svg"));
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toBe(RAW_CSP);
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    const html = await get(join(bed.R, "x.html"));
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toBe("application/octet-stream");
    expect(html.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(html.headers["content-security-policy"]).toBe(RAW_CSP);
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers an unknown route and an unknown upload route with the fixed 404", async () => {
    const nope = await rawGet(bed.t.port, "/files/nope", { cookie: bed.cookie });
    expect([nope.status, nope.body]).toEqual([404, NOT_FOUND_BODY]);
    const upload = await rawPost(bed.t.port, "/upload/x", bed.browser, "x");
    expect([upload.status, upload.body]).toEqual([404, NOT_FOUND_BODY]);
  });
});

describe("security: traversal on PUT /files/raw", () => {
  const put = (path: string) =>
    rawPut(bed.t.port, `/files/raw?path=${enc(path)}&conflict=replace`, bed.browser, "OVERWRITTEN");

  it("answers 404, with no secret, to every hostile form, and leaves the private files intact", async () => {
    for (const row of traversalRows(bed).filter((candidate) => candidate.noPut !== true)) {
      const reply = await put(row.path);
      expect([row.label, reply.status, reply.body]).toEqual([row.label, 404, NOT_FOUND_BODY]);
      expectNoSecrets(reply.body, row.label);
    }
    expectPrivateFilesIntact();
  });

  it("places the control file", async () => {
    const reply = await put(join(bed.R, "ok-put.txt"));
    expect(reply.status).toBe(200);
    expect(readFileSync(join(bed.R, "ok-put.txt"), "utf8")).toBe("OVERWRITTEN");
  });
});

describe("security: traversal on search, diff, status and terminals", () => {
  it("files.search refuses every hostile root and finds the control", async () => {
    for (const row of traversalRows(bed).filter((candidate) => candidate.search !== undefined)) {
      expectRefused(
        `search ${row.label}`,
        await call("files.search", { root: row.path, query: "secret" }),
        row.search as Code,
      );
    }
    const found = await call("files.search", { root: bed.R, query: "ok" });
    expect(found).toMatchObject({ ok: true });
    expect((found as { result: { paths: string[] } }).result.paths).toContain("ok.txt");
  });

  it("vcs.fileDiff refuses every hostile path and diffs the control", async () => {
    for (const row of traversalRows(bed).filter((candidate) => candidate.diff !== undefined)) {
      const [path, code] = row.diff as readonly [string, Code];
      const root = row.path === bed.free ? bed.free : bed.R;
      const frame = await call("vcs.fileDiff", {
        root,
        path,
        from: { kind: "worktree" },
        to: { kind: "worktree" },
      });
      expectRefused(`diff ${row.label}`, frame, code);
    }
    const diff = await call("vcs.fileDiff", {
      root: bed.R,
      path: "ok.txt",
      from: { kind: "head" },
      to: { kind: "worktree" },
    });
    expect(diff).toMatchObject({ ok: true, result: { before: "ok\n", after: "ok, changed\n" } });
  });

  it("subscribe.vcs and vcs.refresh refuse every hostile root; the control opens and delivers its snapshot", async () => {
    for (const row of traversalRows(bed).filter((candidate) => candidate.vcs !== undefined)) {
      for (const method of ["subscribe.vcs", "vcs.refresh"] as const) {
        expectRefused(`${method} ${row.label}`, await call(method, { root: row.path }), row.vcs as Code);
      }
    }
    expect(outcomeOf(await call("vcs.refresh", { root: bed.R }))).toBe("ok");
    const opened = await call("subscribe.vcs", { root: bed.R });
    if (!opened.ok) throw new Error("subscribe failed");
    const { sub } = opened.result as { sub: string };
    const snapshot = await bed.client.waitForEvent((frame) => frame.sub === sub, 8_000);
    expect((snapshot.event as { kind: string }).kind).toBe("snapshot");
  });

  it("terminal.create refuses every hostile working folder and starts a shell in the control", async () => {
    let n = 0;
    const requestId = (): string => `traversal-request-${String(++n).padStart(4, "0")}`;
    for (const row of traversalRows(bed).filter((candidate) => candidate.term !== undefined)) {
      const frame = await call("terminal.create", {
        requestId: requestId(),
        cwd: row.path,
        cols: 80,
        rows: 24,
      });
      expectRefused(`terminal.create ${row.label}`, frame, row.term as Code);
    }
    const made = await call("terminal.create", { requestId: requestId(), cwd: bed.R, cols: 80, rows: 24 });
    expect(outcomeOf(made)).toBe("ok");
    const terminalId = (made as { result: { terminalId: string } }).result.terminalId;
    expect(outcomeOf(await call("terminal.close", { terminalId }))).toBe("ok");
  });
});
