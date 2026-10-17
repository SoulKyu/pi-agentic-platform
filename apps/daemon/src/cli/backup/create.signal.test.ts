import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackup, type BackupDeps } from "./create.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let scratch: string;
let home: string;
let outDir: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-signal-"));
  home = join(scratch, "home");
  outDir = join(scratch, "out");
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO schema_migrations VALUES ('kernel/202610100000_init.sql')");
  db.close();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const deps = (extra: Partial<BackupDeps>): BackupDeps => ({
  home,
  piDir: join(scratch, "pi"),
  outDir,
  now: new Date(Date.UTC(2026, 9, 17, 10, 0, 0)),
  papVersion: "0.0.0",
  secrets: "include",
  skip: new Set(["pi"]),
  allowLarge: false,
  ...extra,
});

describe("a backup cut short", () => {
  it("removes the .part file and the stage folder (a plain snapshot) before the process goes, and leaves no handler behind", async () => {
    const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const exits: string[] = [];
    let seen: { part: boolean; stage: boolean } | undefined;
    const encrypt = async (stream: Readable, part: string): Promise<void> => {
      writeFileSync(part, "half");
      process.emit("SIGINT", "SIGINT");
      seen = {
        part: existsSync(part),
        stage: readdirSync(join(home, "tmp")).some((name) => name.startsWith(".backup-stage-")),
      };
      for await (const chunk of stream) void chunk;
    };
    // in a real run the process is gone by now; here the run goes on and fails on the missing .part
    await createBackup(deps({ encrypt, exitOnSignal: (signal) => void exits.push(signal) })).catch(
      () => undefined,
    );
    expect(exits).toEqual(["SIGINT"]);
    expect(seen).toEqual({ part: false, stage: false });
    expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM")).toBe(before);
  });

  it("a backup of the same name that appears while this one is written is never replaced", async () => {
    const encrypt = async (stream: Readable, part: string): Promise<void> => {
      writeFileSync(part, "mine");
      writeFileSync(join(outDir, "pap-backup-20261017T100000Z.tar.gz.enc"), "theirs");
      for await (const chunk of stream) void chunk;
    };
    await expect(createBackup(deps({ encrypt }))).rejects.toThrow(/exists/);
    expect(readFileSync(join(outDir, "pap-backup-20261017T100000Z.tar.gz.enc"), "utf8")).toBe("theirs");
    expect(readdirSync(outDir)).toEqual(["pap-backup-20261017T100000Z.tar.gz.enc"]);
  });

  it("the tar child has a timeout", async () => {
    await createBackup(deps({ secrets: "exclude" }));
    const calls = vi.mocked(childProcess.spawn).mock.calls.filter((call) => call[0] === "tar");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[2]).toMatchObject({ timeout: 3_600_000, killSignal: "SIGKILL" });
  });
});
