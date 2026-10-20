import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createVaultStore, type VaultStore } from "../secrets/index.ts";
import {
  createOwnerSecrets,
  MAX_OWNER_SECRET_BYTES,
  MAX_OWNER_SECRETS,
  OwnerSecretsError,
  type OwnerSecretsCollector,
} from "./owner-secrets.ts";
import { readPiAuth } from "./pi-auth-values.ts";

/*
 * Mutants (RT-43), each run for real in the T15b report:
 *  - M-auth-nested: the walk of auth.json stops at the top level -> "collects every string of 8 characters or more" fails.
 *  - M-auth-source: auth.json left out of the collector -> the same case fails.
 *  - M-vault-source: vault values left out -> the same case fails.
 *  - M-claude-source: the Claude token left out -> the same case fails.
 *  - M-short: the 8-character floor removed -> "leaves a 7-character value out" fails.
 *  - M-fail-open: a failing source is swallowed -> "refuses when a source fails" fails (three sources).
 *  - M-cap-count / M-cap-bytes: a cap removed -> "refuses past the caps" fails.
 *  - M-log-value: the error is logged whole -> "logs the class and counts, never a value" fails.
 */
const KEY = `sk-test-${"A".repeat(24)}`;
const ACCESS = `access-${"B".repeat(20)}`;
const REFRESH = `refresh-${"C".repeat(20)}`;
const NESTED = `nested-${"D".repeat(12)}`;
const VAULT_VALUE = `vault-value-${"E".repeat(10)}`;
const CLAUDE = `claude-token-${"F".repeat(16)}`;
const SEVEN = "1234567";
const EIGHT = "12345678";

let root: string;
let agentDir: string;
let store: VaultStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t15b-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  store = createVaultStore(join(root, "vault"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeAuth = (data: unknown): void =>
  writeFileSync(join(agentDir, "auth.json"), typeof data === "string" ? data : JSON.stringify(data));
const authFile = {
  anthropic: { type: "api_key", key: KEY },
  "openai-codex": {
    type: "oauth",
    access: ACCESS,
    refresh: REFRESH,
    expires: 1_900_000_000_000,
    extra: { deep: [NESTED] },
  },
  short: { type: "api_key", key: SEVEN },
};

function collector(extra: { vault?: () => readonly string[]; claude?: () => string | null } = {}) {
  const log = captureLogger();
  const collect: OwnerSecretsCollector = createOwnerSecrets({
    logger: log.logger,
    auth: () => readPiAuth(agentDir),
    vault: extra.vault ?? (() => store.everyValue()),
    claudeToken: extra.claude ?? (() => CLAUDE),
  });
  return { collect, log };
}

describe("the owner's secrets (AVM-E46)", () => {
  it("collects every string of 8 characters or more from auth.json (nested too), the vault and the Claude token", async () => {
    writeAuth(authFile);
    store.set("owner1", { kind: "agent", agentId: "scout-0001" }, "TOKEN", VAULT_VALUE, 1);
    store.set("owner1", { kind: "user" }, "FORGE", EIGHT.repeat(2), 1);
    const { secrets } = await collector().collect();
    expect([...secrets].sort()).toEqual(
      [KEY, ACCESS, REFRESH, NESTED, VAULT_VALUE, EIGHT.repeat(2), CLAUDE].sort(),
    );
  });

  it("leaves a 7-character value out and keeps an 8-character one", async () => {
    writeAuth({ a: { type: "api_key", key: SEVEN }, b: { type: "api_key", key: EIGHT } });
    store.set("owner1", { kind: "user" }, "SHORT", SEVEN, 1);
    const { secrets } = await collector({ claude: () => null }).collect();
    expect(secrets).toEqual([EIGHT]);
  });

  it("names every provider of auth.json, with or without a secret to scan", async () => {
    writeAuth(authFile);
    const { providers } = await collector().collect();
    expect([...providers].sort()).toEqual(["anthropic", "openai-codex", "short"]);
  });

  it("collects nothing from a missing auth.json, an empty vault and no token", async () => {
    const result = await collector({ claude: () => null }).collect();
    expect(result).toEqual({ secrets: [], providers: [] });
  });

  it.each([
    ["auth.json", () => writeAuth(`{ "x": ${JSON.stringify(KEY)} oops`), undefined, undefined],
    [
      "the vault",
      () => writeAuth({}),
      () => {
        throw Object.assign(new Error(`cannot open ${VAULT_VALUE}`), { code: "unreadable" });
      },
      undefined,
    ],
    [
      "the Claude token",
      () => writeAuth({}),
      undefined,
      () => {
        throw new Error(`broken ${CLAUDE}`);
      },
    ],
  ] as const)(
    "refuses when %s fails, and the log holds the source and a class, never a value",
    async (name, setup, vault, claude) => {
      setup();
      const { collect, log } = collector({
        ...(vault ? { vault } : {}),
        ...(claude ? { claude } : {}),
      });
      await expect(collect()).rejects.toBeInstanceOf(OwnerSecretsError);
      const text = JSON.stringify(log.lines);
      for (const value of [KEY, VAULT_VALUE, CLAUDE]) expect(text).not.toContain(value);
      expect(log.lines.some((line) => line.msg === "owner_secrets_unreadable")).toBe(true);
      expect(name.length).toBeGreaterThan(0);
    },
  );

  it("the refusal carries no value either", async () => {
    writeAuth(`{ "x": ${JSON.stringify(KEY)} oops`);
    const error = await collector()
      .collect()
      .then(
        () => new Error("resolved"),
        (caught: unknown) => caught as Error,
      );
    expect(String(error.message) + String(error.stack ?? "") + String(error.cause ?? "")).not.toContain(KEY);
  });

  it("refuses past the caps, and the log holds counts only", async () => {
    const many = Array.from(
      { length: MAX_OWNER_SECRETS + 1 },
      (_, i) => `value-${String(i).padStart(8, "0")}`,
    );
    const count = collector({ vault: () => many });
    await expect(count.collect()).rejects.toBeInstanceOf(OwnerSecretsError);
    const big = collector({ vault: () => ["x".repeat(MAX_OWNER_SECRET_BYTES + 1)] });
    await expect(big.collect()).rejects.toBeInstanceOf(OwnerSecretsError);
    for (const { log } of [count, big]) {
      const line = log.lines.find((one) => one.msg === "owner_secrets_capped");
      expect(line).toBeDefined();
      expect(Object.keys(line as object).sort()).toEqual(
        expect.arrayContaining(["bytes", "count", "level", "msg"]),
      );
      expect(JSON.stringify(log.lines)).not.toContain("value-0000");
      expect(JSON.stringify(log.lines)).not.toContain("xxxxxxxx");
    }
  });

  it("reads each time, never from a cache", async () => {
    writeAuth({ a: { type: "api_key", key: KEY } });
    const { collect } = collector({ claude: () => null });
    expect((await collect()).secrets).toEqual([KEY]);
    writeAuth({ a: { type: "api_key", key: ACCESS } });
    expect((await collect()).secrets).toEqual([ACCESS]);
  });
});
