import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelperOpError } from "../ops.ts";
import {
  createNoticeKeeper,
  HANDLER_FAILED_NOTICE,
  NOTICE_CHARS,
  NOTICES_MAX,
  runServerTest,
  within,
} from "./mcp-test.ts";

let root: string;
let ctx: { agentDir: string; papHome: string; home: string; cwd: string; signal: AbortSignal };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-mcpt-h-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "work", "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  ctx = { agentDir, papHome: join(root, "pap"), home, cwd, signal: new AbortController().signal };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const marker = () => join(root, "marker");
const spawner = () => ({ command: "touch", args: [marker()] });
const write = (path: string, servers: Record<string, unknown>) =>
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
const attempt = (params: { scope: "global" | "project"; name: string }, withCwd = true) => {
  const { cwd, ...rest } = ctx;
  return runServerTest({ ...params, deadlineMs: 1_000 }, withCwd ? { ...rest, cwd } : rest);
};
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );

describe("mcp.test: what is refused before anything starts", () => {
  it("refuses a project server of an untrusted folder (project_untrusted), and starts nothing (M7R94)", async () => {
    write(join(ctx.cwd, ".pi", "mcp.json"), { evil: spawner() });
    expect(await codeOf(attempt({ scope: "project", name: "evil" }))).toBe("project_untrusted");
    new ProjectTrustStore(ctx.agentDir).set(ctx.cwd, false);
    expect(await codeOf(attempt({ scope: "project", name: "evil" }))).toBe("project_untrusted");
    expect(existsSync(marker())).toBe(false);
  });

  it("needs a folder for a project server", async () => {
    expect(await codeOf(attempt({ scope: "project", name: "evil" }, false))).toBe("bad_params");
  });

  it("answers not_found for a name the file does not hold, and for the names every object has", async () => {
    write(join(ctx.agentDir, "mcp.json"), { alpha: spawner() });
    expect(await codeOf(attempt({ scope: "global", name: "beta" }))).toBe("not_found");
    for (const name of ["toString", "hasOwnProperty"])
      expect(await codeOf(attempt({ scope: "global", name }))).toBe("not_found");
    for (const name of ["constructor", "prototype", "__proto__"])
      expect(await codeOf(attempt({ scope: "global", name }))).toBe("bad_params");
    expect(existsSync(marker())).toBe(false);
  });

  it("answers not_found when the file does not exist, and config_invalid for a file that is not JSON", async () => {
    expect(await codeOf(attempt({ scope: "global", name: "alpha" }))).toBe("not_found");
    writeFileSync(join(ctx.agentDir, "mcp.json"), "{ not json");
    expect(await codeOf(attempt({ scope: "global", name: "alpha" }))).toBe("config_invalid");
  });

  it("refuses an entry Pi cannot load (no command, no URL, a sse transport) as bad_params", async () => {
    write(join(ctx.agentDir, "mcp.json"), {
      empty: { enabled: true },
      sse: { type: "sse", url: "https://h.example/sse" },
      shape: "text",
      badurl: { url: "file:///etc/passwd" },
    });
    for (const name of ["empty", "sse", "shape", "badurl"])
      expect(await codeOf(attempt({ scope: "global", name })), name).toBe("bad_params");
  });

  it("refuses a file that is a link out of its folder, without reading it", async () => {
    write(join(root, "elsewhere.json"), { alpha: spawner() });
    symlinkSync(join(root, "elsewhere.json"), join(ctx.agentDir, "mcp.json"));
    expect(await codeOf(attempt({ scope: "global", name: "alpha" }))).toBe("config_path_refused");
    expect(existsSync(marker())).toBe(false);
  });
});

describe("mcp.test: a symlinked folder is judged on its real path", () => {
  it("refuses a project reached through a link to an untrusted real folder", async () => {
    write(join(ctx.cwd, ".pi", "mcp.json"), { evil: spawner() });
    const link = join(root, "work", "link");
    symlinkSync(ctx.cwd, link);
    const through = { ...ctx, cwd: link };
    const run = () => runServerTest({ scope: "project", name: "evil", deadlineMs: 1_000 }, through);
    expect(await codeOf(run())).toBe("project_untrusted");
    new ProjectTrustStore(ctx.agentDir).set(ctx.cwd, false);
    expect(await codeOf(run())).toBe("project_untrusted");
    expect(existsSync(marker())).toBe(false);
  });
});

describe("mcp.test: waiting for the handler", () => {
  it("turns a rejected handler into the fixed notice, finished (MC45 I2)", async () => {
    const { notices, keep } = createNoticeKeeper();
    const finished = await within(
      1_000,
      new AbortController().signal,
      Promise.reject(new Error("sk-SECRET")),
      keep,
    );
    expect(finished).toBe(true);
    expect(notices).toEqual([HANDLER_FAILED_NOTICE]);
  });

  it("returns false at once for a signal that is already aborted, without waiting for the work", async () => {
    const controller = new AbortController();
    controller.abort();
    const { notices, keep } = createNoticeKeeper();
    expect(await within(60_000, controller.signal, new Promise(() => {}), keep)).toBe(false);
    expect(notices).toEqual([]);
  });

  it("returns false when the signal aborts while it waits", async () => {
    const controller = new AbortController();
    const waiting = within(60_000, controller.signal, new Promise(() => {}), () => {});
    controller.abort();
    expect(await waiting).toBe(false);
  });
});

describe("mcp.test: the notices kept", () => {
  it("keeps at most 16, each clipped to 2048 characters", () => {
    const { notices, keep } = createNoticeKeeper();
    for (let i = 0; i < NOTICES_MAX + 5; i += 1) keep(`${i}`.padEnd(NOTICE_CHARS + 100, "x"));
    expect(notices).toHaveLength(NOTICES_MAX);
    expect(notices.every((notice) => notice.length === NOTICE_CHARS)).toBe(true);
    expect(notices[0]?.startsWith("0")).toBe(true);
  });
});
