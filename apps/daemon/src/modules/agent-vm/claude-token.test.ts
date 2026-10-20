import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createClaudeTokenStore } from "./claude-token.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-follow-read: `load` opens without O_NOFOLLOW -> "does not read through a link" returns the outside file's text.
 *  - M-in-place: `set` writes the final path itself instead of a temporary name renamed over it -> "a link at the final path
 *    is replaced, never written through" changes the outside file (and "no partial file" sees the truncated window).
 *  - M-mode: the file is created 0644 -> "keeps the file 0600 in a 0700 folder" fails.
 *  - M-log: a log line carries the token -> "no log line, status or error holds the token" fails.
 *  - M-value: `status()` answers the token -> "status is set or missing, never the value" fails.
 */
const TOKEN = "sk-ant-oat01-OWNER-SETUP-TOKEN-0123456789";
let root: string;
let secrets: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-claude-token-"));
  secrets = join(root, "secrets");
  outside = join(root, "outside.txt");
  writeFileSync(outside, "outside-original");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const file = () => join(secrets, "claude-token");
const store = () => {
  const { logger, lines } = captureLogger();
  return { store: createClaudeTokenStore({ secretsDir: secrets, logger }), lines };
};

describe("the Claude token store", () => {
  it("keeps the file 0600 in a 0700 folder it creates (M-mode)", () => {
    const { store: tokens } = store();
    tokens.set(TOKEN);
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readFileSync(file(), "utf8")).toBe(TOKEN);
    expect(tokens.load()).toBe(TOKEN);
  });

  it("tightens a folder that was left open", () => {
    mkdirSync(secrets, { mode: 0o755 });
    chmodSync(secrets, 0o755);
    store().store.set(TOKEN);
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
  });

  it("writes whole then renames: a second set leaves one file and no temporary one", () => {
    const { store: tokens } = store();
    tokens.set(TOKEN);
    tokens.set(`${TOKEN}-2`);
    expect(readdirSync(secrets)).toEqual(["claude-token"]);
    expect(tokens.load()).toBe(`${TOKEN}-2`);
  });

  it("does not read through a link (M-follow-read)", () => {
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(outside, TOKEN);
    symlinkSync(outside, file());
    const { store: tokens, lines } = store();
    expect(tokens.load()).toBeNull();
    expect(tokens.status()).toBe("missing");
    expect(lines.some((line) => line.msg === "claude_token_unreadable")).toBe(true);
  });

  it("a link at the final path is replaced, never written through (M-in-place)", () => {
    mkdirSync(secrets, { mode: 0o700 });
    symlinkSync(outside, file());
    const { store: tokens } = store();
    tokens.set(TOKEN);
    expect(readFileSync(outside, "utf8")).toBe("outside-original");
    expect(lstatSync(file()).isSymbolicLink()).toBe(false);
    expect(tokens.load()).toBe(TOKEN);
  });

  it("refuses a secrets folder that is a link", () => {
    mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(root, "elsewhere"), secrets);
    const { store: tokens, lines } = store();
    expect(() => tokens.set(TOKEN)).toThrow();
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
    // M12: the refusal leaves a line, by class only.
    expect(lines.filter((line) => line.msg === "claude_token_folder_refused")).toEqual([
      expect.objectContaining({ level: "error", err: "link" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("status is set or missing, never the value (M-value)", () => {
    const { store: tokens } = store();
    expect(tokens.status()).toBe("missing");
    tokens.set(TOKEN);
    expect(tokens.status()).toBe("set");
    expect(JSON.stringify(tokens.status())).not.toContain(TOKEN);
  });

  it("clear removes the file and tells the listeners null; clearing a missing token is fine", () => {
    const { store: tokens } = store();
    const heard: Array<string | null> = [];
    tokens.onChange((token) => void heard.push(token));
    tokens.set(TOKEN);
    tokens.clear();
    tokens.clear();
    expect(readdirSync(secrets)).toEqual([]);
    expect(heard).toEqual([TOKEN, null, null]);
    expect(tokens.status()).toBe("missing");
  });

  it("reads nothing from a file that is not a token", () => {
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(file(), "line one\nline two");
    expect(store().store.load()).toBeNull();
    writeFileSync(file(), "x".repeat(2048));
    expect(store().store.load()).toBeNull();
    writeFileSync(file(), `${TOKEN}\n`);
    expect(store().store.load()).toBe(TOKEN);
  });

  it("no log line, status or error holds the token (M-log)", () => {
    const { store: tokens, lines } = store();
    tokens.set(TOKEN);
    tokens.load();
    tokens.clear();
    mkdirSync(secrets, { recursive: true });
    writeFileSync(file(), `${TOKEN}\nsecond`);
    tokens.load();
    symlinkSync(outside, join(secrets, "other"));
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
  });
});
