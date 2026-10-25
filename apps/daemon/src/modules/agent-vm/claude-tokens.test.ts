import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createVaultStore, type VaultStore } from "../secrets/index.ts";
import { CLAUDE_TOKEN_NAME, createClaudeTokens } from "./claude-tokens.ts";

/*
 * Mutants: the user id ignored (one slot for everybody) -> "keeps one token per user" fails; `migrateLegacy` writing before
 * reading the vault -> "the vault wins" fails; the file removed on a vault failure -> "an unreadable vault keeps the file"
 * fails; a log line carrying the value -> "no log line holds a token" fails.
 */
const TOKEN = "sk-ant-oat01-OWNER-SETUP-TOKEN-0123456789";
const OTHER = "sk-ant-oat01-MEMBER-SETUP-TOKEN-9876543210";
let root: string;
let secrets: string;
let vault: VaultStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-claude-tokens-"));
  secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  vault = createVaultStore(join(secrets, "vault"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const legacy = () => join(secrets, "claude-token");
const make = () => {
  const { logger, lines } = captureLogger();
  return {
    tokens: createClaudeTokens({ vault, clock: createFakeClock(), logger, secretsDir: secrets }),
    lines,
  };
};

describe("the Claude tokens", () => {
  it("keeps one token per user, in the vault's user scope", () => {
    const { tokens } = make();
    tokens.set("owner1", TOKEN);
    tokens.set("member1", OTHER);
    expect(tokens.get("owner1")).toBe(TOKEN);
    expect(tokens.get("member1")).toBe(OTHER);
    expect(tokens.get("nobody")).toBeNull();
    expect(vault.reveal("owner1", { kind: "user" })[CLAUDE_TOKEN_NAME]).toBe(TOKEN);
    tokens.clear("owner1");
    expect(tokens.get("owner1")).toBeNull();
    expect(tokens.get("member1")).toBe(OTHER);
  });

  it("status is set or missing, never the value", () => {
    const { tokens } = make();
    expect(tokens.status("owner1")).toBe("missing");
    tokens.set("owner1", TOKEN);
    expect(tokens.status("owner1")).toBe("set");
    expect(tokens.status("member1")).toBe("missing");
    expect(JSON.stringify(tokens.status("owner1"))).not.toContain(TOKEN);
  });

  it("tells the listeners whose token changed, and clearing a missing token is fine", () => {
    const { tokens } = make();
    const heard: string[] = [];
    const stop = tokens.onChange((ownerId) => void heard.push(ownerId));
    tokens.set("owner1", TOKEN);
    tokens.clear("member1");
    stop();
    tokens.clear("owner1");
    expect(heard).toEqual(["owner1", "member1"]);
  });

  it("no log line holds a token", () => {
    const { tokens, lines } = make();
    tokens.set("owner1", TOKEN);
    tokens.clear("owner1");
    writeFileSync(legacy(), `${TOKEN}\nsecond`);
    tokens.migrateLegacy("owner1");
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("the legacy token file", () => {
  it("moves to the owner's vault and is removed", () => {
    writeFileSync(legacy(), `${TOKEN}\n`, { mode: 0o600 });
    const { tokens } = make();
    tokens.migrateLegacy("owner1");
    expect(tokens.get("owner1")).toBe(TOKEN);
    expect(existsSync(legacy())).toBe(false);
  });

  it("with no owner yet the file is left alone", () => {
    writeFileSync(legacy(), TOKEN);
    const { tokens } = make();
    tokens.migrateLegacy(null);
    expect(readFileSync(legacy(), "utf8")).toBe(TOKEN);
    expect(vault.everyValue()).toEqual([]);
  });

  it("with both a vault entry and the file the vault wins and the file goes", () => {
    const { tokens } = make();
    tokens.set("owner1", OTHER);
    writeFileSync(legacy(), TOKEN);
    tokens.migrateLegacy("owner1");
    expect(tokens.get("owner1")).toBe(OTHER);
    expect(existsSync(legacy())).toBe(false);
  });

  it("an unreadable vault keeps the file, warns and boots", () => {
    const { tokens, lines } = make();
    tokens.set("owner1", OTHER);
    rmSync(join(secrets, "vault", "key"));
    writeFileSync(legacy(), TOKEN);
    expect(() => tokens.migrateLegacy("owner1")).not.toThrow();
    expect(readFileSync(legacy(), "utf8")).toBe(TOKEN);
    expect(lines.some((line) => line.level === "warn" && line.msg === "claude_token_migration_kept")).toBe(
      true,
    );
    expect(tokens.get("owner1")).toBeNull();
  });

  // A4a review M4. Mutant: `read` answers "missing" for a vault failure, or warns on every call.
  it("tells an unreadable vault from a missing token and warns once per episode", () => {
    const { tokens, lines } = make();
    tokens.set("owner1", TOKEN);
    expect(tokens.read("owner1")).toEqual({ state: "set", token: TOKEN });
    expect(tokens.read("member1")).toEqual({ state: "missing" });
    rmSync(join(secrets, "vault", "key"));
    for (let i = 0; i < 3; i++) expect(tokens.read("owner1")).toEqual({ state: "unreadable" });
    expect(tokens.get("owner1")).toBeNull();
    expect(lines.filter((line) => line.msg === "claude_token_unreadable")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("leaves a link, an odd file or a missing file alone and does not read through a link", () => {
    const { tokens, lines } = make();
    tokens.migrateLegacy("owner1");
    writeFileSync(join(root, "outside"), TOKEN);
    symlinkSync(join(root, "outside"), legacy());
    tokens.migrateLegacy("owner1");
    expect(tokens.get("owner1")).toBeNull();
    expect(lines.some((line) => line.msg === "claude_token_legacy_unreadable")).toBe(true);
    rmSync(legacy());
    writeFileSync(legacy(), "line one\nline two");
    tokens.migrateLegacy("owner1");
    expect(existsSync(legacy())).toBe(true);
    expect(tokens.get("owner1")).toBeNull();
  });
});
