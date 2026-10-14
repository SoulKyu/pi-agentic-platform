import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  root = mkdtempSync(join(tmpdir(), "pap-mcpw-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "work", "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  ctx = { agentDir, home, cwd };
  globalFile = join(agentDir, "mcp.json");
  projectFile = join(cwd, ".pi", "mcp.json");
  new ProjectTrustStore(agentDir).set(cwd, true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const text = (servers: Record<string, unknown>, indent = 2) =>
  `${JSON.stringify({ mcpServers: servers }, null, indent)}\n`;
const SERVERS = {
  alpha: { command: "npx", args: ["-y", "alpha"], env: { TOKEN: "lit" } },
  beta: { url: "https://h.example/mcp", headers: { Authorization: "Bearer x" }, custom: { keep: [1, 2] } },
  gamma: { command: "gamma" },
};
const read = (path: string) => readFileSync(path, "utf8");
const rows = (...names: string[]) => names.map((name) => ({ scope: "global" as const, name }));
const confirm = { confirmProtected: true as const };

describe("mcp.setEnabled", () => {
  it("disables then enables a server and returns the file to its exact original bytes", async () => {
    const original = text(SERVERS);
    writeFileSync(globalFile, original);
    const off = await setEnabled({ servers: rows("beta"), enabled: false }, ctx);
    expect(off.results).toEqual([{ scope: "global", name: "beta", ok: true }]);
    expect(JSON.parse(read(globalFile)).mcpServers.beta.enabled).toBe(false);
    await setEnabled({ servers: rows("beta"), enabled: true }, ctx);
    expect(read(globalFile)).toBe(original);
  });

  it("keeps unknown keys, the key order and the file's tab indentation", async () => {
    writeFileSync(
      globalFile,
      `{\n\t"other": 1,\n\t"mcpServers": {\n\t\t"b": { "command": "b", "x": 1 },\n\t\t"a": { "command": "a" }\n\t},\n\t"tail": true\n}\n`,
    );
    await setEnabled({ servers: rows("a"), enabled: false }, ctx);
    expect(read(globalFile)).toBe(
      `{\n\t"other": 1,\n\t"mcpServers": {\n\t\t"b": {\n\t\t\t"command": "b",\n\t\t\t"x": 1\n\t\t},\n\t\t"a": {\n\t\t\t"command": "a",\n\t\t\t"enabled": false\n\t\t}\n\t},\n\t"tail": true\n}\n`,
    );
  });

  it("a no-op leaves the file untouched: same bytes, same mtime", async () => {
    const original = `{"mcpServers":{"a":{"command":"a"}}}`;
    writeFileSync(globalFile, original);
    const past = new Date(1_000_000_000_000);
    utimesSync(globalFile, past, past);
    await setEnabled({ servers: rows("a"), enabled: true }, ctx);
    expect(read(globalFile)).toBe(original);
    expect(statSync(globalFile).mtimeMs).toBe(past.getTime());
  });

  it("switches a group, and reports the refused row (an invalid entry) without stopping the others", async () => {
    writeFileSync(
      globalFile,
      text({ ...SERVERS, broken: "not an object", noTransport: { description: "x" } }),
    );
    const { results } = await setEnabled(
      { servers: rows("alpha", "broken", "ghost", "gamma", "noTransport"), enabled: false },
      ctx,
    );
    expect(results).toEqual([
      { scope: "global", name: "alpha", ok: true },
      { scope: "global", name: "broken", ok: false, code: "invalid_entry" },
      { scope: "global", name: "ghost", ok: false, code: "not_found" },
      { scope: "global", name: "gamma", ok: true },
      { scope: "global", name: "noTransport", ok: false, code: "invalid_entry" },
    ]);
    const after = JSON.parse(read(globalFile)).mcpServers;
    expect(after.alpha.enabled).toBe(false);
    expect(after.gamma.enabled).toBe(false);
    expect(after.beta.enabled).toBeUndefined();
    expect(after.broken).toBe("not an object");
  });

  it("writes the global file 0600, even when it was 0644", async () => {
    writeFileSync(globalFile, text(SERVERS), { mode: 0o644 });
    await setEnabled({ servers: rows("alpha"), enabled: false }, ctx);
    expect(statSync(globalFile).mode & 0o777).toBe(0o600);
  });

  it("refuses a missing or unparsable file with the file's own error", async () => {
    await expect(setEnabled({ servers: rows("a"), enabled: false }, ctx)).resolves.toEqual({
      results: [{ scope: "global", name: "a", ok: false, code: "not_found" }],
    });
    writeFileSync(globalFile, "{ nope");
    await expect(setEnabled({ servers: rows("a"), enabled: false }, ctx)).rejects.toMatchObject({
      code: "config_invalid",
    });
    expect(read(globalFile)).toBe("{ nope");
  });
});

describe("mcp.setExposure", () => {
  it("deletes the key for codemode, writes the others", async () => {
    writeFileSync(globalFile, text(SERVERS));
    await setExposure({ scope: "global", name: "alpha", exposure: "direct" }, ctx);
    expect(JSON.parse(read(globalFile)).mcpServers.alpha.exposure).toBe("direct");
    await setExposure({ scope: "global", name: "alpha", exposure: "codemode" }, ctx);
    expect(read(globalFile)).toBe(text(SERVERS));
  });

  it("keeps the key in a project override, where it replaces the global value", async () => {
    writeFileSync(globalFile, text(SERVERS));
    writeFileSync(projectFile, text({ alpha: { exposure: "hidden" } }));
    await setExposure({ scope: "project", name: "alpha", exposure: "codemode", ...confirm }, ctx);
    expect(JSON.parse(read(projectFile)).mcpServers.alpha).toEqual({ exposure: "codemode" });
  });
});

describe("mcp.setInProject", () => {
  it("appends an override { enabled: false }, and keeps it as { enabled: true } on re-enable", async () => {
    writeFileSync(globalFile, text(SERVERS));
    await setInProject({ name: "alpha", enabled: false, ...confirm }, ctx);
    expect(read(projectFile)).toBe(text({ alpha: { enabled: false } }));
    await setInProject({ name: "alpha", enabled: true, ...confirm }, ctx);
    expect(read(projectFile)).toBe(text({ alpha: { enabled: true } }));
  });

  it("creates the project file 0644 with its .pi folder 0755", async () => {
    rmSync(join(ctx.cwd, ".pi"), { recursive: true });
    writeFileSync(globalFile, text(SERVERS));
    await setInProject({ name: "alpha", enabled: false, ...confirm }, ctx);
    expect(statSync(projectFile).mode & 0o777).toBe(0o644);
    expect(statSync(join(ctx.cwd, ".pi")).mode & 0o777).toBe(0o755);
  });

  it("does not create an override for a name the global file lacks, nor for an enable that changes nothing", async () => {
    writeFileSync(globalFile, text(SERVERS));
    await expect(setInProject({ name: "ghost", enabled: false, ...confirm }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
    await setInProject({ name: "alpha", enabled: true, ...confirm }, ctx);
    expect(() => statSync(projectFile)).toThrow();
  });

  it("enables over a globally disabled server with { enabled: true }", async () => {
    writeFileSync(globalFile, text({ alpha: { command: "a", enabled: false } }));
    await setInProject({ name: "alpha", enabled: true, ...confirm }, ctx);
    expect(read(projectFile)).toBe(text({ alpha: { enabled: true } }));
  });
});

describe("mcp.remove and restore", () => {
  it("removes an entry and puts it back at its index, byte for byte", async () => {
    const original = text(SERVERS);
    writeFileSync(globalFile, original);
    const removed = await removeServer({ scope: "global", name: "beta" }, ctx);
    expect(removed.index).toBe(1);
    expect(Object.keys(JSON.parse(read(globalFile)).mcpServers)).toEqual(["alpha", "gamma"]);
    await restoreServer({ scope: "global", name: "beta", index: removed.index, entry: removed.entry }, ctx);
    expect(read(globalFile)).toBe(original);
  });

  it("refuses to restore over a name the file defines again (conflict) and leaves the file alone", async () => {
    writeFileSync(globalFile, text(SERVERS));
    const removed = await removeServer({ scope: "global", name: "beta" }, ctx);
    await addServer({ scope: "global", name: "beta", entry: { command: "new" } }, ctx);
    const before = read(globalFile);
    await expect(
      restoreServer({ scope: "global", name: "beta", index: removed.index, entry: removed.entry }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(read(globalFile)).toBe(before);
  });

  it("refuses a restore whose name shares a namespace with a present one (my-srv removed, my_srv added) (MC44 M2)", async () => {
    writeFileSync(globalFile, text({ "my-srv": { command: "x" } }));
    const removed = await removeServer({ scope: "global", name: "my-srv" }, ctx);
    await addServer({ scope: "global", name: "my_srv", entry: { command: "y" } }, ctx);
    await expect(
      restoreServer({ scope: "global", name: "my-srv", index: removed.index, entry: removed.entry }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(Object.keys(JSON.parse(read(globalFile)).mcpServers)).toEqual(["my_srv"]);
  });

  it("answers not_found for a name the file lacks, and refuses a restored entry that is not an object", async () => {
    writeFileSync(globalFile, text(SERVERS));
    await expect(removeServer({ scope: "global", name: "ghost" }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      restoreServer({ scope: "global", name: "x", index: 0, entry: "[1]" }, ctx),
    ).rejects.toMatchObject({ code: "bad_params" });
  });

  it("removes an invalid entry too (clean-up), and refuses an entry too big for the undo record", async () => {
    writeFileSync(
      globalFile,
      text({ ...SERVERS, broken: 5, big: { command: "x", description: "d".repeat(300_000) } }),
    );
    await removeServer({ scope: "global", name: "broken" }, ctx);
    await expect(removeServer({ scope: "global", name: "big" }, ctx)).rejects.toMatchObject({
      code: "bad_params",
    });
    expect(JSON.parse(read(globalFile)).mcpServers.big).toBeDefined();
  });
});

describe("mcp.add", () => {
  it("appends the entry, creating the file 0600 when the global file is new", async () => {
    await addServer({ scope: "global", name: "fresh", entry: { command: "fresh", env: { K: "lit" } } }, ctx);
    expect(read(globalFile)).toBe(text({ fresh: { command: "fresh", env: { K: "lit" } } }));
    expect(statSync(globalFile).mode & 0o777).toBe(0o600);
  });

  it("refuses an existing name, and a name sharing the namespace of one (conflict)", async () => {
    writeFileSync(globalFile, text(SERVERS));
    await expect(
      addServer({ scope: "global", name: "alpha", entry: { command: "x" } }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    writeFileSync(globalFile, text({ "my-srv": { command: "x" } }));
    await expect(
      addServer({ scope: "global", name: "my_srv", entry: { command: "y" } }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an invalid entry or name as bad_params", async () => {
    for (const [name, entry] of [
      ["ok", {}],
      ["ok", { command: "" }],
      ["ok", { command: "x", args: Array(300).fill("a") }],
      ["ok", { command: "x", env: { A: "v".repeat(70 * 1024) } }],
      ["__proto__", { command: "x" }],
      ["bad name", { command: "x" }],
    ] as const)
      await expect(addServer({ scope: "global", name, entry }, ctx)).rejects.toMatchObject({
        code: "bad_params",
      });
  });
});

describe("mcp.setEnabled: a save that fails (MC44 M1)", () => {
  it("marks only the failing file's rows write_failed; rows of the file already written stay ok", async () => {
    new ProjectTrustStore(ctx.agentDir).set(ctx.cwd, true);
    writeFileSync(globalFile, text(SERVERS));
    writeFileSync(projectFile, text({ alpha: { enabled: true } }));
    // a second hard link makes the project file refuse the write (config_hard_link) after the global one was written
    linkSync(projectFile, join(ctx.cwd, "other-name.json"));
    const { results } = await setEnabled(
      {
        servers: [
          { scope: "global", name: "alpha" },
          { scope: "project", name: "alpha" },
          { scope: "global", name: "gamma" },
        ],
        enabled: false,
        ...confirm,
      },
      ctx,
    );
    expect(results).toEqual([
      { scope: "global", name: "alpha", ok: true },
      { scope: "project", name: "alpha", ok: false, code: "write_failed" },
      { scope: "global", name: "gamma", ok: true },
    ]);
    expect(JSON.parse(read(globalFile)).mcpServers.alpha.enabled).toBe(false);
    expect(JSON.parse(read(projectFile)).mcpServers.alpha.enabled).toBe(true);
  });
});
