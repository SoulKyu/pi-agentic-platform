import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSystemClock } from "../kernel/clock.ts";
import { captureLogger } from "../testing/capture-logger.ts";
import type { TestClient } from "../testing/ws-client.ts";
import {
  type FileBed,
  mintToken,
  outcomeOf,
  rawPost,
  rawPut,
  SECRET_TEXT,
  startFileBed,
} from "./testing/fixtures.ts";

// Spec C §8.1, classes "forged Origin" and "token scope", on the routes M8 adds (M8R67, M8R91, agreement 5, owner f8/f10).
const captured = captureLogger();
/** The refusal log is rate limited per 10 s: a test that wants each refusal logged moves the clock past the window. */
let skewMs = 0;
const clock = { ...createSystemClock(), now: () => Date.now() + skewMs };

let bed: FileBed;
let bot: TestClient;
beforeAll(async () => {
  bed = await startFileBed({ deps: { logger: captured.logger, clock } });
  bot = await bed.t.connectBearer(
    await mintToken(bed, ["files:read", "files:operate", "vcs:read", "sessions:operate"]),
  );
}, 60_000);
afterAll(async () => {
  bot?.close();
  await bed?.stop();
});

const enc = encodeURIComponent;
const put = (path: string, headers: Record<string, string>) =>
  rawPut(bed.t.port, `/files/raw?path=${enc(path)}&conflict=replace`, headers, "FORGED\n");
const upload = (headers: Record<string, string>) =>
  rawPost(bed.t.port, "/upload?sessionId=s1&name=a.txt", headers, "FORGED\n");

describe("security: Origin and credentials on the upload routes", () => {
  it("refuses PUT /files/raw and POST /upload without an Origin or with a foreign one, logs each, and writes nothing", async () => {
    const target = join(bed.R, "forged.txt");
    const cookie = { cookie: bed.cookie };
    const attempts: Array<[string, () => Promise<{ status: number; body: string }>]> = [
      ["PUT without Origin", () => put(target, cookie)],
      ["PUT with a foreign Origin", () => put(target, { ...cookie, origin: "https://evil.test" })],
      ["POST /upload without Origin", () => upload(cookie)],
      ["POST /upload with a foreign Origin", () => upload({ ...cookie, origin: "https://evil.test" })],
    ];
    const before = captured.lines.filter((line) => line.msg === "origin_refused").length;
    for (const [label, send] of attempts) {
      skewMs += 11_000;
      const reply = await send();
      expect([label, reply.status]).toEqual([label, 403]);
      expect(reply.body, label).not.toContain("FORGED");
    }
    const logged = captured.lines.filter((line) => line.msg === "origin_refused").slice(before);
    expect(logged.map((line) => [line.via, line.origin])).toEqual([
      ["http", "(none)"],
      ["http", "https://evil.test"],
      ["http", "(none)"],
      ["http", "https://evil.test"],
    ]);
    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(captured.lines)).not.toContain(bed.cookie.split("=")[1] ?? "no-cookie");
  });

  it("answers 401 to a real token with a good Origin and no cookie: the file routes take a browser session only", async () => {
    const value = await mintToken(bed, ["files:operate", "sessions:operate"]);
    const bearer = { authorization: `Bearer ${value}`, origin: bed.t.origin };
    const target = join(bed.R, "bearer.txt");
    expect((await put(target, bearer)).status).toBe(401);
    expect((await upload(bearer)).status).toBe(401);
    // A token beside a good cookie does not make the request a browser's either.
    expect((await put(target, { ...bearer, cookie: bed.cookie })).status).toBe(401);
    expect(existsSync(target)).toBe(false);
  });
});

describe("security: what a token holds over /ws", () => {
  it("a token without files:read cannot read, a token without terminal:operate cannot open a shell", async () => {
    const reader = await bed.t.connectBearer(await mintToken(bed, ["sessions:read"]));
    expect(outcomeOf(await reader.call("files.read", { path: join(bed.R, "ok.txt") }))).toBe("forbidden");
    reader.close();
    expect(
      outcomeOf(
        await bot.call("terminal.create", {
          requestId: "token-terminal-0001",
          cwd: bed.R,
          cols: 80,
          rows: 24,
        }),
      ),
    ).toBe("forbidden");
    expect(outcomeOf(await bot.call("subscribe.terminal", {}))).toBe("forbidden");
  });

  it("a token cannot be minted with terminal:operate or terminal:read (M8R2)", async () => {
    await bed.t.confirmStepUp(bed.cookie);
    for (const permission of ["terminal:operate", "terminal:read"]) {
      const created = await bed.client.call("auth.tokens.create", {
        name: "shell",
        permissions: [permission] as never,
        expiresInDays: 7,
      });
      expect([permission, outcomeOf(created)]).toEqual([permission, "bad_request"]);
    }
  });
});

describe("security: tokens never make a code-running change (agreement 5)", () => {
  it("writes an ordinary file, and answers forbidden to every protected target and to any confirmation", async () => {
    const write = (path: string, confirm: boolean) =>
      bot.call("files.write", {
        path,
        text: "token wrote\n",
        baseEtag: null,
        ...(confirm ? { confirmProtected: true as const } : {}),
      });
    expect(outcomeOf(await write(join(bed.R, "a.txt"), false))).toBe("ok");
    expect(readFileSync(join(bed.R, "a.txt"), "utf8")).toBe("token wrote\n");
    const refused: Array<[string, boolean]> = [
      [".git/hooks/x", true],
      [".git/hooks/x", false],
      ["b.txt", true],
      [".pi/x.json", false],
      [".pi/x.json", true],
      [".envrc", false],
      [".envrc", true],
    ];
    for (const [name, confirm] of refused) {
      const frame = await write(join(bed.R, name), confirm);
      expect([name, confirm, outcomeOf(frame)]).toEqual([name, confirm, "forbidden"]);
      expect(existsSync(join(bed.R, name)), name).toBe(false);
    }
  });
});

describe("security: tokens never touch Pi's folder (agreement 6, owner f10, MC30)", () => {
  it("answers not_found, never forbidden, to every read, listing and write aimed at <agentDir>/extensions", async () => {
    const folder = join(bed.agentDir, "extensions");
    const file = join(folder, "e.ts");
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, "export default () => {};\n");
    // The browser session reads both: only the caller's kind tells them apart.
    expect(outcomeOf(await bed.client.call("files.read", { path: file }))).toBe("ok");
    expect(outcomeOf(await bed.client.call("files.list", { path: folder }))).toBe("ok");
    expect(outcomeOf(await bot.call("files.read", { path: file }))).toBe("not_found");
    expect(outcomeOf(await bot.call("files.list", { path: folder }))).toBe("not_found");
    const created = join(folder, "new.ts");
    for (const target of [file, created]) {
      for (const confirm of [false, true]) {
        const frame = await bot.call("files.write", {
          path: target,
          text: "TOKEN\n",
          baseEtag: null,
          ...(confirm ? { confirmProtected: true as const } : {}),
        });
        expect([target, confirm, outcomeOf(frame)]).toEqual([target, confirm, "not_found"]);
      }
    }
    expect(readFileSync(file, "utf8")).toBe("export default () => {};\n");
    expect(existsSync(created)).toBe(false);
  });
});

describe("security: tokens never read keys (owner f8, f10)", () => {
  it("hides a project's .pi/mcp.json and .mcp.json from a token that the browser session reads", async () => {
    for (const name of [".pi/mcp.json", ".mcp.json"]) {
      const path = join(bed.R, name);
      expect([name, outcomeOf(await bed.client.call("files.read", { path }))]).toEqual([name, "ok"]);
      const frame = await bot.call("files.read", { path });
      expect([name, outcomeOf(frame)]).toEqual([name, "not_found"]);
    }
  });

  it("with the home folder as a root, a token reads nothing of home's dot-entries and sees them as protected", async () => {
    const key = await bot.call("files.read", { path: join(bed.userHome, ".ssh/id") });
    expect(outcomeOf(key)).toBe("not_found");
    expect(JSON.stringify(key)).not.toContain("SECRET_TEXT_ssh_key");
    // Home's other dot-entries: the owner reads them, a token does not (only the name tells them apart).
    const rc = join(bed.userHome, ".bashrc");
    expect(await bed.client.call("files.read", { path: rc })).toMatchObject({
      ok: true,
      result: { text: "# rc\n" },
    });
    expect(outcomeOf(await bot.call("files.read", { path: rc }))).toBe("not_found");
    const listed = await bot.call("files.list", { path: bed.userHome });
    if (!listed.ok) throw new Error("list failed");
    const entries = (listed.result as { entries: Array<{ name: string; protected: boolean }> }).entries;
    expect(entries.find((entry) => entry.name === ".ssh")).toMatchObject({ protected: true });
    expect(entries.find((entry) => entry.name === "proj")).toMatchObject({ protected: false });
  });

  it("files.search never returns a .pi/mcp.json or .mcp.json to a token, and the owner finds them", async () => {
    const owner = await bed.client.call("files.search", { root: bed.R, query: "mcp" });
    const ownerPaths = (owner as { result: { paths: string[] } }).result.paths;
    expect(ownerPaths).toEqual(expect.arrayContaining([".pi/mcp.json", ".mcp.json"]));
    const token = await bot.call("files.search", { root: bed.R, query: "mcp" });
    if (!token.ok) throw new Error("search failed");
    expect((token.result as { paths: string[] }).paths).toEqual([]);
    const home = await bot.call("files.search", { root: bed.userHome, query: "ssh" });
    if (!home.ok) throw new Error("search failed");
    expect((home.result as { paths: string[] }).paths).toEqual([]);
  });

  it("vcs.fileDiff of a committed .pi/mcp.json is not_found for a token and a diff for the browser session", async () => {
    const side = { kind: "head" } as const;
    const params = { root: bed.R, path: ".pi/mcp.json", from: side, to: side };
    expect(outcomeOf(await bed.client.call("vcs.fileDiff", params))).toBe("ok");
    const frame = await bot.call("vcs.fileDiff", params);
    expect(outcomeOf(frame)).toBe("not_found");
    expect(JSON.stringify(frame)).not.toContain("mcpServers");
    expect(JSON.stringify(frame)).not.toContain(SECRET_TEXT);
  });
});
