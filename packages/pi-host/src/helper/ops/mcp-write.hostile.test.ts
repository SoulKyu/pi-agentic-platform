import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addServer,
  removeServer,
  restoreServer,
  setEnabled,
  setExposure,
  setInProject,
} from "./mcp-write.ts";

let root: string;
let ctx: { agentDir: string; home: string; cwd: string };
let globalFile: string;
let projectFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-mcpw-h-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "work", "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  ctx = { agentDir, home, cwd };
  globalFile = join(agentDir, "mcp.json");
  projectFile = join(cwd, ".pi", "mcp.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const trust = (decision: boolean) => new ProjectTrustStore(ctx.agentDir).set(ctx.cwd, decision);
const read = (path: string) => readFileSync(path, "utf8");
const confirm = { confirmProtected: true as const };
const PROJECT = `${JSON.stringify({ mcpServers: { alpha: { enabled: false } } }, null, 2)}\n`;
const GLOBAL = `${JSON.stringify({ mcpServers: { alpha: { command: "a" } } }, null, 2)}\n`;

describe("prototype keys", () => {
  it("a server named __proto__ in the file: editing another server keeps Object.prototype clean and the entry intact", async () => {
    writeFileSync(
      globalFile,
      `{\n  "mcpServers": {\n    "__proto__": { "command": "evil", "polluted": true },\n    "alpha": { "command": "a" }\n  }\n}\n`,
    );
    await setEnabled({ servers: [{ scope: "global", name: "alpha" }], enabled: false }, ctx);
    await setExposure({ scope: "global", name: "alpha", exposure: "direct" }, ctx);
    await addServer({ scope: "global", name: "beta", entry: { command: "b" } }, ctx);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    const servers = JSON.parse(read(globalFile)).mcpServers;
    expect(Object.hasOwn(servers, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(servers, "__proto__")?.value).toEqual({
      command: "evil",
      polluted: true,
    });
    expect(Object.keys(servers)).toEqual(["__proto__", "alpha", "beta"]);
  });

  it("refuses to switch, remove-by-edit or add the names __proto__, constructor and prototype", async () => {
    writeFileSync(globalFile, GLOBAL);
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const { results } = await setEnabled({ servers: [{ scope: "global", name }], enabled: false }, ctx);
      expect(results[0]).toMatchObject({ ok: false, code: "not_found" });
      await expect(addServer({ scope: "global", name, entry: { command: "x" } }, ctx)).rejects.toMatchObject({
        code: "bad_params",
      });
    }
    expect(read(globalFile)).toBe(GLOBAL);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("removing and restoring a __proto__ entry keeps it an own key", async () => {
    writeFileSync(globalFile, `{"mcpServers":{"__proto__":{"command":"e"},"alpha":{"command":"a"}}}\n`);
    const removed = await removeServer({ scope: "global", name: "__proto__" }, ctx);
    expect(Object.keys(JSON.parse(read(globalFile)).mcpServers)).toEqual(["alpha"]);
    await restoreServer(
      { scope: "global", name: "__proto__", index: removed.index, entry: removed.entry },
      ctx,
    );
    const servers = JSON.parse(read(globalFile)).mcpServers;
    expect(Object.keys(servers)).toEqual(["__proto__", "alpha"]);
    expect(Object.getOwnPropertyDescriptor(servers, "__proto__")?.value).toEqual({ command: "e" });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("project files", () => {
  it("a project file that is a link out of the project: config_path_refused, nothing written", async () => {
    trust(true);
    writeFileSync(globalFile, GLOBAL);
    const outside = join(root, "outside.json");
    writeFileSync(outside, PROJECT);
    symlinkSync(outside, projectFile);
    await expect(setInProject({ name: "alpha", enabled: false, ...confirm }, ctx)).rejects.toMatchObject({
      code: "config_path_refused",
    });
    expect(read(outside)).toBe(PROJECT);
  });

  it("an untrusted project is forbidden (project_untrusted), for every project write", async () => {
    writeFileSync(globalFile, GLOBAL);
    writeFileSync(projectFile, PROJECT);
    for (const decision of [undefined, false]) {
      if (decision !== undefined) trust(decision);
      const attempts = [
        () => setEnabled({ servers: [{ scope: "project", name: "alpha" }], enabled: true, ...confirm }, ctx),
        () => setExposure({ scope: "project", name: "alpha", exposure: "direct", ...confirm }, ctx),
        () => setInProject({ name: "alpha", enabled: true, ...confirm }, ctx),
        () => removeServer({ scope: "project", name: "alpha", ...confirm }, ctx),
        () => addServer({ scope: "project", name: "n", entry: { command: "x" }, ...confirm }, ctx),
        () => restoreServer({ scope: "project", name: "n", index: 0, entry: "{}", ...confirm }, ctx),
      ];
      for (const attempt of attempts)
        await expect(attempt()).rejects.toMatchObject({ code: "project_untrusted" });
      expect(read(projectFile)).toBe(PROJECT);
    }
  });

  it("every project write without confirmProtected is protected_path and the file is unchanged; with it, it is written", async () => {
    trust(true);
    writeFileSync(globalFile, GLOBAL);
    writeFileSync(projectFile, PROJECT);
    const attempts = [
      () => setEnabled({ servers: [{ scope: "project", name: "alpha" }], enabled: true }, ctx),
      () => setExposure({ scope: "project", name: "alpha", exposure: "direct" }, ctx),
      () => setInProject({ name: "alpha", enabled: true }, ctx),
      () => removeServer({ scope: "project", name: "alpha" }, ctx),
      () => addServer({ scope: "project", name: "n", entry: { command: "x" } }, ctx),
      () => restoreServer({ scope: "project", name: "n", index: 0, entry: "{}" }, ctx),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: "protected_path" });
    expect(read(projectFile)).toBe(PROJECT);
    await addServer({ scope: "project", name: "n", entry: { command: "x" }, ...confirm }, ctx);
    expect(Object.keys(JSON.parse(read(projectFile)).mcpServers)).toEqual(["alpha", "n"]);
  });

  it("a project write needs a cwd", async () => {
    await expect(
      addServer(
        { scope: "project", name: "n", entry: { command: "x" }, ...confirm },
        { ...ctx, cwd: undefined },
      ),
    ).rejects.toMatchObject({ code: "bad_params" });
  });

  it("refuses auth.provider in a project file, and in no other case", async () => {
    trust(true);
    const entry = { url: "https://h.example/mcp", auth: { provider: "github" } };
    await expect(addServer({ scope: "project", name: "n", entry, ...confirm }, ctx)).rejects.toMatchObject({
      code: "bad_params",
    });
    const stdio = { command: "x", auth: { provider: "github" } };
    await expect(
      addServer({ scope: "project", name: "s", entry: stdio, ...confirm }, ctx),
    ).rejects.toMatchObject({
      code: "bad_params",
    });
    await addServer({ scope: "global", name: "n", entry }, ctx);
    expect(JSON.parse(read(globalFile)).mcpServers.n.auth.provider).toBe("github");
  });

  it("the global file is a link out of $HOME: config_path_refused", async () => {
    const outside = join(root, "elsewhere.json");
    writeFileSync(outside, GLOBAL);
    symlinkSync(outside, globalFile);
    await expect(
      setEnabled({ servers: [{ scope: "global", name: "alpha" }], enabled: false }, ctx),
    ).rejects.toMatchObject({
      code: "config_path_refused",
    });
    expect(read(outside)).toBe(GLOBAL);
  });
});

describe("mcp.add bounds: each cap is crossed by one row (MC44 M5, M9)", () => {
  const pairs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, "v"]));
  const refused = (entry: Record<string, unknown>) =>
    addServer({ scope: "global", name: "n", entry }, ctx).then(
      () => "added",
      (error: { code: string }) => error.code,
    );

  it("accepts an entry exactly at each cap and refuses one past it", async () => {
    const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["env keys", { command: "x", env: pairs(128) }, { command: "x", env: pairs(129) }],
      [
        "header keys",
        { url: "https://h.example/m", headers: pairs(128) },
        { url: "https://h.example/m", headers: pairs(129) },
      ],
      ["command", { command: "c".repeat(4096) }, { command: "c".repeat(4097) }],
      [
        "url",
        { url: `https://h.example/${"u".repeat(4096 - 18)}` },
        { url: `https://h.example/${"u".repeat(4096 - 17)}` },
      ],
      ["one arg", { command: "x", args: ["a".repeat(8192)] }, { command: "x", args: ["a".repeat(8193)] }],
      ["args", { command: "x", args: Array(256).fill("a") }, { command: "x", args: Array(257).fill("a") }],
      [
        "env value",
        { command: "x", env: { A: "v".repeat(65_536) } },
        { command: "x", env: { A: "v".repeat(65_537) } },
      ],
      [
        "env key",
        { command: "x", env: { ["k".repeat(256)]: "v" } },
        { command: "x", env: { ["k".repeat(257)]: "v" } },
      ],
    ];
    for (const [label, atCap, pastCap] of rows) {
      writeFileSync(globalFile, `{"mcpServers":{}}\n`);
      expect(await refused(atCap), `${label} at the cap`).toBe("added");
      expect(await refused(pastCap), `${label} past the cap`).toBe("bad_params");
    }
  });

  it("refuses an entry whose text is over the undo record size (MC44 M5), the file unchanged", async () => {
    writeFileSync(globalFile, GLOBAL);
    expect(await refused({ command: "x", description: "d".repeat(300_000) })).toBe("bad_params");
    expect(read(globalFile)).toBe(GLOBAL);
  });
});
