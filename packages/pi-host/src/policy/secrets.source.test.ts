import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretSource, readBounded } from "./secrets.ts";

// `mkfifo` makes the FIFO a test needs; a constant keeps knip from reading it as a dependency.
const MKFIFO = "mkfifo";

let stderr: { mock: { calls: unknown[][] }; mockRestore(): void } | undefined;
const lines = () => (stderr?.mock.calls ?? []).map((call) => String(call[0]));
function captureStderr() {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}
afterEach(() => {
  stderr?.mockRestore();
  stderr = undefined;
});

describe("createSecretSource", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function agentDir(authJson?: object): string {
    const dir = mkdtempSync(join(tmpdir(), "pap-secrets-"));
    dirs.push(dir);
    if (authJson) writeFileSync(join(dir, "auth.json"), JSON.stringify(authJson));
    return dir;
  }
  const bump = (dir: string, seconds: number) => {
    const when = new Date(Date.now() + seconds * 1000);
    utimesSync(join(dir, "auth.json"), when, when);
  };

  it("rebuilds the redactor when auth.json changed and only then (M5R121)", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    expect(first.text("x at-0123456789").text).toBe("x [SECRET:AUTH_OPENAI_ACCESS]");
    source.refresh();
    expect(source.current()).toBe(first);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { access: "at-9876543210" } }));
    bump(dir, 2);
    source.refresh();
    expect(source.current()).not.toBe(first);
    expect(source.current().text("at-9876543210").text).toBe("[SECRET:AUTH_OPENAI_ACCESS]");
  });

  it("a missing auth.json is fine; one that appears later is read", () => {
    const dir = agentDir();
    captureStderr();
    const source = createSecretSource({ env: { MY_TOKEN: "env-0123456789" }, agentDir: dir });
    source.refresh();
    expect(lines()).toEqual([]);
    expect(source.current().text("env-0123456789").count).toBe(1);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { access: "at-0123456789" } }));
    source.refresh();
    expect(source.current().text("at-0123456789").count).toBe(1);
    expect(source.current().text("env-0123456789").count).toBe(1);
  });

  it("a later corrupt file keeps the current set and writes one line per change of code", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    writeFileSync(join(dir, "auth.json"), "{broken");
    bump(dir, 2);
    source.refresh();
    writeFileSync(join(dir, "auth.json"), "{broken again");
    bump(dir, 4);
    source.refresh();
    expect(source.current()).toBe(first);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (invalid-json)\n"]);
  });

  it("an auth.json above 1 MiB contributes nothing and is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-secrets-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), " ".repeat(1024 * 1024 + 1));
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    expect(source.current().size).toBe(0);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (too-large)\n"]);
  });

  it("rebuilds when the file was replaced with the same size and mtime (a new inode)", () => {
    const dir = agentDir({ openai: { access: "at-0123456789" } });
    const path = join(dir, "auth.json");
    const fixed = 1_700_000_000;
    utimesSync(path, fixed, fixed);
    const source = createSecretSource({ env: {}, agentDir: dir });
    const first = source.current();
    const replacement = join(dir, "auth.json.new");
    writeFileSync(replacement, JSON.stringify({ openai: { access: "at-9876543210" } }));
    utimesSync(replacement, fixed, fixed);
    renameSync(replacement, path);
    source.refresh();
    expect(source.current()).not.toBe(first);
    expect(source.current().text("at-9876543210").count).toBe(1);
  });

  it("a FIFO or a link to /dev/zero is not read, does not hang, and is reported once", () => {
    const dir = agentDir();
    const path = join(dir, "auth.json");
    execFileSync(MKFIFO, [path]);
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    source.refresh();
    expect(source.current().size).toBe(0);
    rmSync(path);
    symlinkSync("/dev/zero", path);
    source.refresh();
    expect(source.current().size).toBe(0);
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (not-a-file)\n"]);
  });

  it("a file above 1 MiB at the refresh is refused without being read", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "auth.json"), "{}");
    captureStderr();
    const source = createSecretSource({ env: {}, agentDir: dir });
    writeFileSync(join(dir, "auth.json"), " ".repeat(1024 * 1024 + 5));
    source.refresh();
    expect(lines()).toEqual(["pi-host: auth.json not read for redaction (too-large)\n"]);
  });

  it("readBounded stops one byte past its bound: a file that grew after the stat is refused", () => {
    const dir = agentDir();
    const path = join(dir, "grown");
    writeFileSync(path, "x".repeat(50));
    expect(readBounded(path, 50)).toEqual({ text: "x".repeat(50) });
    expect(readBounded(path, 49)).toEqual({ problem: "too-large" });
  });

  it("readBounded refuses a FIFO that took the file's place after the stat, without waiting for a writer", () => {
    const dir = agentDir();
    const path = join(dir, "fifo");
    execFileSync(MKFIFO, [path]);
    expect(readBounded(path)).toEqual({ problem: "not-a-file" });
  });
});
