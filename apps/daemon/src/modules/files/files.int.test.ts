import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpRequest } from "../../testing/http-client.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

let t: TestDaemon | undefined;
let client: TestClient | undefined;
let cookie = "";
afterEach(async () => {
  client?.close();
  client = undefined;
  await t?.stop();
  t = undefined;
});

/** A session in the harness's `work` folder makes it one of the owner's project roots. */
async function connected(): Promise<TestClient> {
  t = await startTestDaemon({ steps: [{ text: "hi" }] });
  cookie = await t.login();
  client = await t.connect(cookie);
  const created = (await client.call("sessions.create", { cwd: t.cwd })) as { ok: boolean };
  expect(created.ok).toBe(true);
  return client;
}

describe("files over the socket", () => {
  it("lists, reads and searches the project, and refuses a path outside it", async () => {
    const c = await connected();
    const cwd = (t as TestDaemon).cwd;
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "hello.ts"), "export const hi = 1;\n");
    const listed = (await c.call("files.list", { path: cwd })) as {
      ok: true;
      result: { entries: Array<{ name: string; kind: string }> };
    };
    expect(listed.result.entries.map((e) => [e.name, e.kind])).toEqual([["src", "dir"]]);
    const read = (await c.call("files.read", { path: join(cwd, "src", "hello.ts") })) as {
      result: { text: string; nextOffset: number | null; meta: { editable: boolean } };
    };
    expect(read.result).toMatchObject({
      text: "export const hi = 1;\n",
      nextOffset: null,
      meta: { editable: true },
    });
    const found = (await c.call("files.search", { root: cwd, query: "hello" })) as {
      result: { paths: string[] };
    };
    expect(found.result.paths).toEqual(["src/hello.ts"]);
    const outside = (await c.call("files.list", { path: (t as TestDaemon).home })) as {
      error: { code: string };
    };
    expect(outside.error.code).toBe("not_found");
    const secret = (await c.call("files.read", { path: join((t as TestDaemon).home, "state.db") })) as {
      error: { code: string };
    };
    expect(secret.error.code).toBe("not_found");
  });

  it("answers bad_request to a relative path", async () => {
    const c = await connected();
    const reply = (await c.call("files.list", { path: "work" })) as { error: { code: string } };
    expect(reply.error.code).toBe("bad_request");
  });

  it("saves through the write gate over the socket, and serves the file raw to the cookie only", async () => {
    const c = await connected();
    const daemon = t as TestDaemon;
    const path = join(daemon.cwd, "note.txt");
    const created = (await c.call("files.write", { path, text: "hello\n", baseEtag: null })) as {
      result: { meta: { etag: string; size: number } };
    };
    expect(created.result.meta.size).toBe(6);
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    const stale = (await c.call("files.write", { path, text: "x", baseEtag: null })) as {
      error: { code: string };
    };
    expect(stale.error.code).toBe("conflict");
    mkdirSync(join(daemon.cwd, ".git", "hooks"), { recursive: true });
    const hook = (await c.call("files.write", {
      path: join(daemon.cwd, ".git", "hooks", "pre-commit"),
      text: "#!/bin/sh\n",
      baseEtag: null,
    })) as { error: { code: string } };
    expect(hook.error.code).toBe("protected_path");

    const url = `${daemon.base}/files/raw?path=${encodeURIComponent(path)}`;
    const served = await httpRequest(url, { headers: { cookie } });
    expect([served.status, served.body]).toEqual([200, "hello\n"]);
    expect(served.headers["content-disposition"]).toBe(
      `attachment; filename="note.txt"; filename*=UTF-8''note.txt`,
    );
    expect(served.headers["content-security-policy"]).toMatch(/^sandbox;/);
    expect((await httpRequest(url)).status).toBe(401);
    expect((await httpRequest(url, { headers: { cookie, authorization: "Bearer pap_x" } })).status).toBe(401);
    const hidden = await httpRequest(
      `${daemon.base}/files/raw?path=${encodeURIComponent(join(daemon.home, "state.db"))}`,
      { headers: { cookie } },
    );
    expect(hidden.status).toBe(404);
  });
});
