import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import {
  callRows,
  dialogIdOf,
  markOf,
  nextDialog,
  rawGet,
  runWithoutCard,
  sessionIdOf,
} from "./testing/fixtures.ts";

// Spec C §8.1, class "path traversal", through the whole daemon: static serving, the export route and the policy's
// own targets. `rawGet` sends each path as written, so nothing normalises it before the daemon sees it.
const SECRET_TEXT = "SECRET_TEXT_beside_the_static_root";
const INDEX_HTML = "<!doctype html><title>pap traversal fixture</title>";
const NOT_FOUND = JSON.stringify({ error: { code: "not_found" } });

describe("security: path traversal, static serving and the export route", () => {
  let dir: string;
  let t: TestDaemon;
  let cookie = "";
  let started = false;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pap-static-"));
    mkdirSync(join(dir, "static/assets"), { recursive: true });
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "static/index.html"), INDEX_HTML);
    writeFileSync(join(dir, "static/assets/a.js"), "export {};");
    writeFileSync(join(dir, "outside/secret.txt"), SECRET_TEXT);
    // A link inside the root that leads out of it.
    symlinkSync("../../outside", join(dir, "static/assets/out"));
    t = await startTestDaemon(
      { steps: [{ text: "unused" }] },
      { config: { staticRoot: join(dir, "static") } },
    );
    started = true;
    cookie = await t.login();
  });
  afterAll(async () => {
    try {
      if (started) await t.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves what is inside the root, as the control for the refusals below", async () => {
    expect(await rawGet(t.port, "/assets/a.js")).toMatchObject({ status: 200, body: "export {};" });
    expect(await rawGet(t.port, "/")).toMatchObject({ status: 200, body: INDEX_HTML });
  });

  it.each([
    "/assets/../../outside/secret.txt",
    "/assets/%2e%2e/%2e%2e/outside/secret.txt",
    "/assets/%252e%252e/secret.txt",
    "/assets/..%2f..%2foutside%2fsecret.txt",
    "/assets\\..\\..\\outside\\secret.txt",
    "/assets/a.js%00.html",
    "/assets/out/secret.txt",
    "//outside/secret.txt",
  ])("refuses %s with a 404 and never serves a file outside the static root", async (path) => {
    const reply = await rawGet(t.port, path);
    expect([reply.status, reply.body]).toEqual([404, NOT_FOUND]);
  });

  // The root-relative check alone would serve these (they resolve to a.js); the path filter refuses what is not canonical.
  it.each(["/assets//a.js", "/assets/x/..%2fa.js"])(
    "refuses %s, a non-canonical way to a file inside the root, with a 404",
    async (path) => {
      const reply = await rawGet(t.port, path);
      expect([reply.status, reply.body]).toEqual([404, NOT_FOUND]);
    },
  );

  // The URL parse before Hono collapses the dot-segment and backslash forms (`/%2e/`, `/x/..`) into paths inside the
  // root, so these never reach the static handler as traversals; what it serves is the root's own index.html.
  it.each(["/%2e/index.html", "/index.html/.."])(
    "answers %s with the root's own index.html at most, never anything else",
    async (path) => {
      const reply = await rawGet(t.port, path);
      expect(reply.body).not.toContain(SECRET_TEXT);
      expect([reply.status, reply.body]).toEqual([200, INDEX_HTML]);
    },
  );

  it("serves a real export URL once, and answers the same URL with one character changed with a 404", async () => {
    const client = await t.connect(cookie);
    const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
    await client.call("subscribe.session", { sessionId });
    const mark = markOf(client);
    await client.call("sessions.prompt", { sessionId, text: "export me" });
    await runWithoutCard(client, mark);
    const exported = await client.call("sessions.exportHtml", { sessionId });
    if (!exported.ok) throw new Error("export failed");
    const url = (exported.result as { url: string }).url;
    const tampered = `${url.slice(0, -1)}${url.endsWith("A") ? "B" : "A"}`;
    expect((await rawGet(t.port, tampered, { cookie })).status).toBe(404);
    expect((await rawGet(t.port, url, { cookie })).status).toBe(200);
    client.close();
  });

  it("answers a traversal in the export route's token with a 404 for the owner, and a 401 without a session", async () => {
    for (const token of [
      "..%2f..%2fstate.db",
      "%2e%2e%2f%2e%2e%2fstate.db",
      "..%5c..%5cstate.db",
      "a".repeat(43) + "%00",
    ]) {
      const path = `/api/sessions/s1/export/${token}`;
      expect([path, (await rawGet(t.port, path, { cookie })).status]).toEqual([path, 404]);
      expect([path, (await rawGet(t.port, path)).status]).toEqual([path, 401]);
    }
    expect(
      (await rawGet(t.port, "/api/sessions/..%2f..%2fx/export/" + "a".repeat(43), { cookie })).status,
    ).toBe(404);
  });
});

describe("security: path traversal, the policy's own targets", () => {
  it("asks before a write leaves the session folder and before a read of pap's database; denied, both stay undone", async () => {
    // The harness's cwd is <root>/work and PAP_HOME is <root>/home: "../home/state.db" reaches pap's database.
    const t = await startTestDaemon({
      steps: [
        { toolCalls: [{ name: "write", args: { path: "../escape.txt", content: "x" }, id: "w" }] },
        { toolCalls: [{ name: "read", args: { path: "../home/state.db" }, id: "r" }] },
        { text: "done" },
      ],
    });
    try {
      const client = await t.connect(await t.login());
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "go" });
      let after = mark;
      for (const expected of [/outside the session directory/, /protected path/]) {
        const card = await nextDialog(client, after);
        after = card.seq;
        expect((card.event as { dialog: { message: string } }).dialog.message).toMatch(expected);
        await client.call("sessions.respondDialog", {
          sessionId,
          dialogId: dialogIdOf(card),
          response: { answer: "deny" },
        });
      }
      await runWithoutCard(client, after);
      expect(existsSync(join(t.root, "escape.txt"))).toBe(false);
      // Newest first.
      expect(
        (await callRows(client, sessionId, 2)).map((row) => [row.toolCallId, row.decision, row.reason]),
      ).toEqual([
        ["r", "denied", "protected path"],
        ["w", "denied", "outside the session directory"],
      ]);
    } finally {
      await t.stop();
    }
  }, 60_000);

  it("asks for a path through a symlink to pap's home and for one whose `..` follows a link out of the folder", async () => {
    // The kernel resolves `lnk/..` through the link (to <root>/elsewhere), where a lexical reading would stay in the folder.
    const t = await startTestDaemon({
      steps: [
        { toolCalls: [{ name: "read", args: { path: "h/state.db" }, id: "r" }] },
        { toolCalls: [{ name: "write", args: { path: "lnk/../escape.txt", content: "x" }, id: "w" }] },
        { text: "done" },
      ],
    });
    try {
      mkdirSync(join(t.root, "elsewhere/deep"), { recursive: true });
      symlinkSync(t.home, join(t.cwd, "h"));
      symlinkSync(join(t.root, "elsewhere/deep"), join(t.cwd, "lnk"));
      const client = await t.connect(await t.login());
      const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
      await client.call("subscribe.session", { sessionId });
      const mark = markOf(client);
      await client.call("sessions.prompt", { sessionId, text: "go" });
      let after = mark;
      for (const expected of [/protected path/, /outside the session directory/]) {
        const card = await nextDialog(client, after);
        after = card.seq;
        expect((card.event as { dialog: { message: string } }).dialog.message).toMatch(expected);
        await client.call("sessions.respondDialog", {
          sessionId,
          dialogId: dialogIdOf(card),
          response: { answer: "deny" },
        });
      }
      await runWithoutCard(client, after);
      expect(existsSync(join(t.root, "elsewhere/escape.txt"))).toBe(false);
      expect(existsSync(join(t.cwd, "escape.txt"))).toBe(false);
      expect(
        (await callRows(client, sessionId, 2)).map((row) => [row.toolCallId, row.decision, row.reason]),
      ).toEqual([
        ["w", "denied", "outside the session directory"],
        ["r", "denied", "protected path"],
      ]);
    } finally {
      await t.stop();
    }
  }, 60_000);
});
