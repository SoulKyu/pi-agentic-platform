import { stat } from "node:fs/promises";
import {
  existsSync,
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
import { HELPER_OPS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeOp } from "../run.ts";
import { OPS } from "../ops.ts";
import { readCodemodeState, setCodemode } from "./codemode-settings.ts";

let root: string;
let ctx: { agentDir: string; home: string };
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-codemode-"));
  const home = join(root, "home");
  ctx = { home, agentDir: join(home, ".pi", "agent") };
  mkdirSync(ctx.agentDir, { recursive: true });
  file = join(ctx.agentDir, "settings.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const put = (settings: unknown) => writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
const get = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("code mode settings (M7R92)", () => {
  it("round-trips Automatic and Always on a modifier-only list: the key is removed, not emptied", async () => {
    put({ defaultTools: ["+codemode"], theme: "dark" });
    expect(await setCodemode({ choice: "automatic" }, ctx)).toEqual({
      choice: "automatic",
      mode: "on",
      inlineBudget: null,
    });
    expect(get()).toEqual({ theme: "dark" });
    expect((await setCodemode({ choice: "always" }, ctx)).choice).toBe("always");
    expect(get().defaultTools).toEqual(["+codemode"]);
  });

  it("appends +codemode to a plain list and to a modifier-only list", async () => {
    put({ defaultTools: ["read", "bash"] });
    await setCodemode({ choice: "always" }, ctx);
    expect(get().defaultTools).toEqual(["read", "bash", "+codemode"]);
    put({ defaultTools: ["-bash"] });
    await setCodemode({ choice: "always" }, ctx);
    expect(get().defaultTools).toEqual(["-bash", "+codemode"]);
  });

  it("Automatic removes every entry naming codemode and keeps the others", async () => {
    put({ defaultTools: ["read", "+codemode", "-bash"] });
    await setCodemode({ choice: "automatic" }, ctx);
    expect(get().defaultTools).toEqual(["read", "-bash"]);
  });

  it("Always replaces a -codemode entry, and leaves a list that already enables it alone", async () => {
    put({ defaultTools: ["-codemode", "-bash"] });
    await setCodemode({ choice: "always" }, ctx);
    expect(get().defaultTools).toEqual(["-bash", "+codemode"]);
    put({ defaultTools: ["read", "codemode"] });
    const before = readFileSync(file, "utf8");
    await setCodemode({ choice: "always" }, ctx);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("Automatic removes the key when it empties a plain list too; `[]` is never written (MC44 M7)", async () => {
    put({ defaultTools: ["codemode"], theme: "dark" });
    await setCodemode({ choice: "automatic" }, ctx);
    expect(get()).toEqual({ theme: "dark" });
  });

  it("reads the current keys for the overview: defaults for a missing file, the keys, null for a broken file", async () => {
    expect((await readCodemodeState(ctx)).settings).toEqual({
      choice: "automatic",
      mode: "on",
      inlineBudget: null,
    });
    put({ defaultTools: ["+codemode"], codemode: { mode: "only", inlineBudget: 500 } });
    expect((await readCodemodeState(ctx)).settings).toEqual({
      choice: "always",
      mode: "only",
      inlineBudget: 500,
    });
    writeFileSync(file, "{ nope");
    expect((await readCodemodeState(ctx)).settings).toBeNull();
  });

  it("Automatic on a file with no defaultTools writes nothing, even when the file does not exist", async () => {
    expect(await setCodemode({ choice: "automatic" }, ctx)).toEqual({
      choice: "automatic",
      mode: "on",
      inlineBudget: null,
    });
    expect(() => statSync(file)).toThrow();
  });

  it("writes codemode.mode only for `only`, removes it for `on`, and the empty codemode object with it", async () => {
    put({ codemode: { inlineBudget: 5 } });
    expect((await setCodemode({ mode: "only" }, ctx)).mode).toBe("only");
    expect(get().codemode).toEqual({ inlineBudget: 5, mode: "only" });
    await setCodemode({ mode: "on", inlineBudget: null }, ctx);
    expect(get()).toEqual({});
  });

  it("writes the inline budget 0..1 000 000 and null removes it", async () => {
    expect((await setCodemode({ inlineBudget: 0 }, ctx)).inlineBudget).toBe(0);
    expect(get().codemode).toEqual({ inlineBudget: 0 });
    await setCodemode({ inlineBudget: 1_000_000 }, ctx);
    expect((await setCodemode({ inlineBudget: null }, ctx)).inlineBudget).toBeNull();
    expect(get()).toEqual({});
  });

  it("refuses a budget of -1 (and other bad values) as bad_params before anything runs", async () => {
    for (const inlineBudget of [-1, 1_000_001, 1.5]) {
      const done = await executeOp(
        {
          type: "helper_run",
          op: "mcp.codemode",
          agentDir: ctx.agentDir,
          papHome: root,
          params: { inlineBudget },
        },
        OPS,
        { home: ctx.home },
        new AbortController().signal,
        { emit: () => {}, prompt: async () => null },
      );
      expect(done).toMatchObject({ ok: false, code: "bad_params" });
    }
    expect(HELPER_OPS["mcp.codemode"].params.safeParse({ inlineBudget: -1 }).success).toBe(false);
    expect(() => statSync(file)).toThrow();
  });

  it("leaves other keys and their order, and the file's mode", async () => {
    writeFileSync(file, `{"a":1,"defaultTools":["read"],"z":2}\n`, { mode: 0o644 });
    await setCodemode({ choice: "always" }, ctx);
    expect(readFileSync(file, "utf8")).toBe(
      `{\n  "a": 1,\n  "defaultTools": [\n    "read",\n    "+codemode"\n  ],\n  "z": 2\n}\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("refuses a defaultTools or codemode of the wrong type, and an unparsable file, without writing", async () => {
    for (const bad of [{ defaultTools: "read" }, { codemode: [] }, { defaultTools: [1] }]) {
      put(bad);
      const before = readFileSync(file, "utf8");
      await expect(setCodemode({ choice: "always", mode: "only" }, ctx)).rejects.toMatchObject({
        code: "config_invalid",
      });
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    writeFileSync(file, "{ nope");
    await expect(setCodemode({ choice: "always" }, ctx)).rejects.toMatchObject({ code: "config_invalid" });
  });

  describe("Pi's settings.json.lock (MC59 M8)", () => {
    it("waits while another process holds the lock folder, then edits and releases it", async () => {
      put({ theme: "dark" });
      mkdirSync(`${file}.lock`);
      const pending = setCodemode({ choice: "always" }, ctx);
      // Far more file system round trips than an unlocked edit needs; a held lock keeps the file as it was.
      for (let trip = 0; trip < 60; trip++) await stat(file);
      expect(get()).toEqual({ theme: "dark" });
      rmSync(`${file}.lock`, { recursive: true });
      await pending;
      expect(get()).toEqual({ theme: "dark", defaultTools: ["+codemode"] });
      expect(existsSync(`${file}.lock`)).toBe(false);
    });

    it("takes over a lock folder older than 30 s", async () => {
      put({});
      mkdirSync(`${file}.lock`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${file}.lock`, old, old);
      await setCodemode({ choice: "always" }, ctx);
      expect(get().defaultTools).toEqual(["+codemode"]);
      expect(existsSync(`${file}.lock`)).toBe(false);
    });

    it("releases the lock when the edit is refused", async () => {
      put({ defaultTools: "read" });
      await expect(setCodemode({ choice: "always" }, ctx)).rejects.toMatchObject({ code: "config_invalid" });
      expect(existsSync(`${file}.lock`)).toBe(false);
    });
  });
});
