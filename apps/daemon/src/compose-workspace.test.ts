import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type HandlerContext } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundaryConfigOf, createWorkspaceModules, denySourcesOf } from "./compose-workspace.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { type Config, loadConfig } from "./kernel/config.ts";
import { judgePath } from "./kernel/fs/boundary.ts";
import { silentLogger } from "./kernel/logger.ts";
import { NO_SCOPES } from "./kernel/supervisor/scope.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { testCaller } from "./testing/caller.ts";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pap-compose-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const touch = (path: string, content = "x"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

/** `home` is the user's home as typed (`~`, possibly a link); everything else under the real folder. */
function configOf(home: string, env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    argv: [],
    env: {
      PAP_HOME: join(base, "real", ".pap"),
      PI_CODING_AGENT_DIR: join(base, "real", ".pi", "agent"),
      ...env,
    },
    cwd: base,
    homedir: home,
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  });
}

describe("the boundary configuration (M8R29)", () => {
  it("holds both spellings of pap's home, Pi's folder and the user's home, and only the typed one when it is missing", () => {
    mkdirSync(join(base, "real", ".pap"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const config = configOf(join(base, "link"), {
      PAP_HOME: join(base, "link", ".pap"),
      PI_CODING_AGENT_DIR: join(base, "missing", "agent"),
    });
    const boundary = boundaryConfigOf(config, {});
    expect(boundary.home).toEqual([join(base, "link"), join(base, "real")]);
    expect(boundary.papHome).toEqual([join(base, "link", ".pap"), join(base, "real", ".pap")]);
    expect(boundary.agentDir).toEqual([join(base, "missing", "agent")]);
    expect(boundary.papHomeOpen).toEqual([]);
    expect(boundary.runtimeDirs).toEqual([]);
  });

  it("resolves a missing Pi folder through its nearest existing parent, so the real spelling exists from boot (I1)", () => {
    mkdirSync(join(base, "real"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const config = configOf(join(base, "link"), {
      PAP_HOME: join(base, "link", ".pap"),
      PI_CODING_AGENT_DIR: join(base, "link", ".pi", "agent"),
    });
    const boundary = boundaryConfigOf(config, {});
    expect(boundary.agentDir).toEqual([
      join(base, "link", ".pi", "agent"),
      join(base, "real", ".pi", "agent"),
    ]);
    expect(boundary.papHome).toEqual([join(base, "link", ".pap"), join(base, "real", ".pap")]);
  });

  it("keeps ~/.bashrc protected and hides ~/.ssh from tokens when ~ is a link (carry 2)", async () => {
    touch(join(base, "real", ".bashrc"));
    touch(join(base, "real", ".ssh", "id"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const boundary = boundaryConfigOf(configOf(join(base, "link")), {});
    // The project is the user's home, spelled as it resolves.
    const roots = [join(base, "real")];
    const session = await judgePath(
      join(base, "real", ".bashrc"),
      { roots, config: boundary, caller: "session" },
      "read",
    );
    expect(session).toMatchObject({ ok: true, protection: "confirm" });
    const token = { roots, config: boundary, caller: "token" } as const;
    expect(await judgePath(join(base, "real", ".ssh", "id"), token, "read")).toEqual({
      ok: false,
      why: "token_hidden",
    });
  });

  it("reads $XDG_RUNTIME_DIR from the environment given, both spellings, and ignores a relative one", () => {
    mkdirSync(join(base, "run"));
    symlinkSync(join(base, "run"), join(base, "run-link"));
    const config = configOf(base);
    expect(boundaryConfigOf(config, { XDG_RUNTIME_DIR: join(base, "run-link") }).runtimeDirs).toEqual([
      join(base, "run-link"),
      join(base, "run"),
    ]);
    expect(boundaryConfigOf(config, { XDG_RUNTIME_DIR: "run" }).runtimeDirs).toEqual([]);
  });
});

describe("the deny set's sources (M8R103, MC8 I3, MC10)", () => {
  it("names Pi's and pap's private entries, the sessions folder, all of $PAP_HOME and the owner's secret stores", () => {
    const boundary = boundaryConfigOf(configOf(join(base, "real")), {});
    const sources = denySourcesOf(boundary);
    const agent = join(base, "real", ".pi", "agent");
    const pap = join(base, "real", ".pap");
    expect(sources.files).toEqual(
      expect.arrayContaining([
        join(agent, "auth.json"),
        join(agent, "settings.json"),
        join(pap, "state.db-wal"),
        join(pap, "pap.lock"),
        join(base, "real", ".docker", "config.json"),
        join(base, "real", ".netrc"),
        join(base, "real", ".git-credentials"),
      ]),
    );
    expect(sources.folders).toEqual(
      expect.arrayContaining([
        join(agent, "sessions"),
        pap,
        join(pap, "secrets"),
        join(pap, "fork-tmp"),
        join(base, "real", ".ssh"),
        join(base, "real", ".gnupg"),
        join(base, "real", ".aws"),
        join(base, "real", ".config", "gh"),
        join(base, "real", ".kube"),
      ]),
    );
    expect(sources.skip).toEqual([join(pap, "attachments")]);
  });

  it("skips attachments/ in both spellings of pap's home, and keeps the owner's open folders as well", () => {
    mkdirSync(join(base, "real", ".pap"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const config = configOf(join(base, "link"), { PAP_HOME: join(base, "link", ".pap") });
    const boundary = { ...boundaryConfigOf(config, {}), papHomeOpen: ["worktrees"] };
    expect(denySourcesOf(boundary).skip).toEqual([
      join(base, "link", ".pap", "worktrees"),
      join(base, "real", ".pap", "worktrees"),
      join(base, "link", ".pap", "attachments"),
      join(base, "real", ".pap", "attachments"),
    ]);
  });
});

describe("the workspace modules", () => {
  const ctx = (caller = testCaller()): HandlerContext => ({
    caller,
    connectionId: "c1",
    openSubscription: vi.fn(),
    closeSubscription: vi.fn(),
  });

  function build(roots: string[]) {
    const config = configOf(join(base, "real"));
    mkdirSync(config.home, { recursive: true });
    mkdirSync(config.piAgentDir, { recursive: true });
    // Far ahead of every file here: nothing counts as changed since the first walk.
    const clock = createFakeClock(Date.now() + 3_600_000);
    return createWorkspaceModules(
      {
        roots: () => roots,
        config,
        clock,
        logger: silentLogger,
        env: { PATH: process.env.PATH },
        hub: createStreamHub(),
        readOnly: false,
        scopes: NO_SCOPES,
      },
      0o022,
    );
  }

  it("serves a project file and refuses a hard link to pap's search.db or to the owner's key", async () => {
    const proj = join(base, "real", "proj");
    touch(join(proj, "ok.txt"), "fine");
    touch(join(base, "real", ".pap", "search.db"), "SECRET");
    touch(join(base, "real", ".ssh", "id_ed25519"), "KEY");
    touch(join(base, "real", ".pi", "agent", "auth.json"), "KEYS");
    linkSync(join(base, "real", ".pap", "search.db"), join(proj, "alias-search.db"));
    linkSync(join(base, "real", ".ssh", "id_ed25519"), join(proj, "alias-key"));
    linkSync(join(base, "real", ".pi", "agent", "auth.json"), join(proj, "alias-auth"));
    const { rpc, shutdown } = build([proj]);
    expect((await rpc["files.read"]({ path: join(proj, "ok.txt") }, ctx())).text).toBe("fine");
    for (const alias of ["alias-search.db", "alias-key", "alias-auth"]) {
      await expect(rpc["files.read"]({ path: join(proj, alias) }, ctx()), alias).rejects.toMatchObject({
        code: "not_found",
      });
    }
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("creates attachments/ 0700, keeps it out of the files routes, and still refuses a private inode linked into it", async () => {
    const home = join(base, "real");
    const proj = join(home, "proj");
    touch(join(proj, "ok.txt"), "fine");
    touch(join(home, ".pap", "search.db"), "SECRET");
    touch(join(home, ".pap", "attachments", "s1", "id", "a.txt"), "uploaded");
    linkSync(join(home, ".pap", "search.db"), join(home, ".pap", "attachments", "s1", "id", "private-alias"));
    linkSync(join(home, ".pap", "search.db"), join(proj, "alias"));
    const { rpc, shutdown } = build([home]);
    expect(statSync(join(home, ".pap", "attachments")).mode & 0o7777).toBe(0o700);
    expect(existsSync(join(home, ".pap", "attachments", "pending"))).toBe(true);
    for (const path of [join(home, ".pap", "attachments", "s1", "id", "a.txt"), join(proj, "alias")])
      await expect(rpc["files.read"]({ path }, ctx()), path).rejects.toMatchObject({ code: "not_found" });
    expect((await rpc["files.read"]({ path: join(proj, "ok.txt") }, ctx())).text).toBe("fine");
    await shutdown();
  });

  it("answers for the roots it is given at each call, not the ones of the first call", async () => {
    const one = join(base, "real", "one");
    const two = join(base, "real", "two");
    touch(join(one, "a.txt"));
    touch(join(two, "b.txt"));
    let roots = [one];
    const config = configOf(join(base, "real"));
    mkdirSync(config.home, { recursive: true });
    const { rpc } = createWorkspaceModules(
      {
        roots: () => roots,
        config,
        clock: createFakeClock(Date.now() + 3_600_000),
        logger: silentLogger,
        env: { PATH: process.env.PATH },
        hub: createStreamHub(),
        readOnly: false,
        scopes: NO_SCOPES,
      },
      0o022,
    );
    expect((await rpc["files.list"]({ path: one }, ctx())).entries.map((e) => e.name)).toEqual(["a.txt"]);
    await expect(rpc["files.list"]({ path: two }, ctx())).rejects.toMatchObject({ code: "not_found" });
    roots = [two];
    expect((await rpc["files.list"]({ path: two }, ctx())).entries.map((e) => e.name)).toEqual(["b.txt"]);
  });

  it("refuses Pi's auth.json created after the first deny walk, when ~ is a link and Pi's folder was missing at boot (I1)", async () => {
    mkdirSync(join(base, "real"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const config = configOf(join(base, "link"), {
      PAP_HOME: join(base, "link", ".pap"),
      PI_CODING_AGENT_DIR: join(base, "link", ".pi", "agent"),
    });
    mkdirSync(config.home, { recursive: true });
    touch(join(base, "real", "ok.txt"), "fine");
    const agent = join(base, "real", ".pi", "agent");
    let roots = [join(base, "real")];
    const { rpc } = createWorkspaceModules(
      {
        roots: () => roots,
        config,
        clock: createFakeClock(Date.now() + 3_600_000),
        logger: silentLogger,
        env: { PATH: process.env.PATH },
        hub: createStreamHub(),
        readOnly: false,
        scopes: NO_SCOPES,
      },
      0o022,
    );
    // The first walk runs here, before Pi has created anything.
    expect((await rpc["files.read"]({ path: join(base, "real", "ok.txt") }, ctx())).text).toBe("fine");
    touch(join(agent, "auth.json"), '{"anthropic":"sk-SECRET"}');
    // Project = home, a browser session.
    await expect(rpc["files.read"]({ path: join(agent, "auth.json") }, ctx())).rejects.toMatchObject({
      code: "not_found",
    });
    // Project = Pi's folder, a token.
    roots = [agent];
    await expect(
      rpc["files.read"]({ path: join(agent, "auth.json") }, ctx(testCaller({ kind: "token" }))),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(rpc["files.read"]({ path: join(agent, "auth.json") }, ctx())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
