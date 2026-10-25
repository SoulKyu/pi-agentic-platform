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
 *  - M-claude-source: a user's Claude token (a vault entry) left out -> the same case fails.
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

function collector(extra: { vault?: () => readonly string[] } = {}) {
  const log = captureLogger();
  const collect: OwnerSecretsCollector = createOwnerSecrets({
    logger: log.logger,
    auth: () => readPiAuth(agentDir),
    vault: extra.vault ?? (() => store.everyValue()),
  });
  return { collect, log };
}

describe("the caps hold a legitimate vault (m6)", () => {
  it("fits 33 full scopes (32 agents and the user's) of 50 names of 4096 characters, and the OAuth metadata", () => {
    expect(MAX_OWNER_SECRETS).toBeGreaterThanOrEqual(33 * 50 + 100);
    expect(MAX_OWNER_SECRET_BYTES).toBeGreaterThanOrEqual(33 * 50 * 4096 + 512 * 1024);
  });
});

describe("the owner's secrets (AVM-E46)", () => {
  it("collects every string of 8 characters or more from auth.json (nested too), the vault and every user's Claude token", async () => {
    writeAuth(authFile);
    store.set("owner1", { kind: "agent", agentId: "scout-0001" }, "TOKEN", VAULT_VALUE, 1);
    store.set("owner1", { kind: "user" }, "FORGE", EIGHT.repeat(2), 1);
    store.set("owner1", { kind: "user" }, "CLAUDE_TOKEN", CLAUDE, 1);
    store.set("owner2", { kind: "user" }, "CLAUDE_TOKEN", `${CLAUDE}-two`, 1);
    const { secrets } = await collector().collect();
    expect([...secrets].sort()).toEqual(
      [KEY, ACCESS, REFRESH, NESTED, VAULT_VALUE, EIGHT.repeat(2), CLAUDE, `${CLAUDE}-two`].sort(),
    );
  });

  it("leaves a 7-character value out and keeps an 8-character one", async () => {
    writeAuth({ a: { type: "api_key", key: SEVEN }, b: { type: "api_key", key: EIGHT } });
    store.set("owner1", { kind: "user" }, "SHORT", SEVEN, 1);
    const { secrets } = await collector().collect();
    expect(secrets).toEqual([EIGHT]);
  });

  it("names every provider of auth.json, with or without a secret to scan", async () => {
    writeAuth(authFile);
    const { providers } = await collector().collect();
    expect([...providers].sort()).toEqual(["anthropic", "openai-codex", "short"]);
  });

  it("collects nothing from a missing auth.json, an empty vault and no token", async () => {
    const result = await collector().collect();
    expect(result).toEqual({ secrets: [], providers: [] });
  });

  it.each([
    ["auth", () => writeAuth(`{ "x": ${JSON.stringify(KEY)} oops`), undefined, "Error"],
    [
      "vault",
      () => writeAuth({}),
      () => {
        throw Object.assign(new Error(`cannot open ${VAULT_VALUE}`), { code: "unreadable" });
      },
      "unreadable",
    ],
  ] as const)(
    "refuses when the %s source fails, and the log holds the source and a class, never a value",
    async (source, setup, vault, err) => {
      setup();
      const { collect, log } = collector(vault ? { vault } : {});
      await expect(collect()).rejects.toBeInstanceOf(OwnerSecretsError);
      for (const value of [KEY, VAULT_VALUE, CLAUDE]) expect(JSON.stringify(log.lines)).not.toContain(value);
      const failed = log.lines.filter((line) => line.msg === "owner_secrets_unreadable");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ source, err });
    },
  );

  // m8: the real vault's own failure path, not a throwing fake.
  it("refuses when a vault scope file is damaged, or the vault key is lost, with the class `unreadable`", async () => {
    store.set("owner1", { kind: "user" }, "FORGE", VAULT_VALUE, 1);
    store.set("owner2", { kind: "user" }, "FORGE", VAULT_VALUE, 1);
    const lost = collector();
    rmSync(join(root, "vault", "key"));
    await expect(lost.collect()).rejects.toBeInstanceOf(OwnerSecretsError);
    expect(lost.log.lines.find((line) => line.msg === "owner_secrets_unreadable")).toMatchObject({
      source: "vault",
      err: "unreadable",
    });
    expect(JSON.stringify(lost.log.lines)).not.toContain(VAULT_VALUE);
    const damaged = collector();
    writeFileSync(join(root, "vault", "owner1", "user.json"), `{ "v": 1, "entries": ${VAULT_VALUE}`, {
      mode: 0o600,
    });
    await expect(damaged.collect()).rejects.toBeInstanceOf(OwnerSecretsError);
    expect(damaged.log.lines.find((line) => line.msg === "owner_secrets_unreadable")).toMatchObject({
      source: "vault",
      err: "unreadable",
    });
  });

  // AVM-E50: Pi's reference syntax is no secret.
  it("leaves a $VAR or !command key out, keeps a $$-escaped one by its literal, and keeps other fields", async () => {
    writeAuth({
      a: { type: "api_key", key: "$OPENAI_API_KEY" },
      b: { type: "api_key", key: "${ANTHROPIC_API_KEY}" },
      c: { type: "api_key", key: "!pass show provider/key" },
      d: { type: "api_key", key: "$$literal-dollar-key" },
      e: { type: "oauth", access: "$notarefaccess-value", refresh: REFRESH, expires: 1 },
    });
    const { secrets } = await collector().collect();
    expect([...secrets].sort()).toEqual(["$literal-dollar-key", "$notarefaccess-value", REFRESH].sort());
  });

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
      expect(line).toMatchObject(
        log === count.log
          ? { count: MAX_OWNER_SECRETS + 1, bytes: many.reduce((n, v) => n + v.length, 0) }
          : { count: 1, bytes: MAX_OWNER_SECRET_BYTES + 1 },
      );
      expect(JSON.stringify(log.lines)).not.toContain("value-0000");
      expect(JSON.stringify(log.lines)).not.toContain("xxxxxxxx");
    }
  });

  it("scales the caps with the number of users, so a second user's vault cannot fail the first's build (M14)", async () => {
    const many = Array.from(
      { length: MAX_OWNER_SECRETS + 1 },
      (_, i) => `value-${String(i).padStart(8, "0")}`,
    );
    const log = captureLogger();
    const three = createOwnerSecrets({
      logger: log.logger,
      auth: () => readPiAuth(agentDir),
      vault: () => many,
      users: () => 3,
    });
    expect((await three()).secrets.length).toBeGreaterThan(MAX_OWNER_SECRETS);
    const tooMany = [...many, ...many.map((value) => `${value}-x`), ...many.map((value) => `${value}-y`)];
    const refused = createOwnerSecrets({
      logger: log.logger,
      auth: () => readPiAuth(agentDir),
      vault: () => tooMany,
      users: () => 3,
    });
    await expect(refused()).rejects.toBeInstanceOf(OwnerSecretsError);
  });

  it("reads each time, never from a cache", async () => {
    writeAuth({ a: { type: "api_key", key: KEY } });
    const { collect } = collector();
    expect((await collect()).secrets).toEqual([KEY]);
    writeAuth({ a: { type: "api_key", key: ACCESS } });
    expect((await collect()).secrets).toEqual([ACCESS]);
  });
});

// S1 item 9 mutants: M-partial-fails-whole (partial rethrows like the collector) and M-partial-no-caps (partial skips the caps).
describe("the partial read for the relay's redactor (S1)", () => {
  it("keeps the values of the sources that read when one fails, and says which one failed", async () => {
    writeAuth(authFile);
    store.set("owner1", { kind: "user" }, "FORGE", VAULT_VALUE, 1);
    for (const broken of ["auth", "vault"] as const) {
      const { collect, log } = collector({
        ...(broken === "vault"
          ? {
              vault: () => {
                throw new Error("boom");
              },
            }
          : {}),
      });
      if (broken === "auth") writeAuth("{ not json");
      await expect(collect()).rejects.toBeInstanceOf(OwnerSecretsError);
      const partial = await collect.partial?.();
      const expected = {
        auth: [VAULT_VALUE],
        vault: [KEY, ACCESS, REFRESH, NESTED],
      }[broken];
      expect([...(partial?.secrets ?? [])].sort()).toEqual([...expected].sort());
      expect(
        log.lines.some((line) => line.msg === "owner_secrets_unreadable" && line.source === broken),
      ).toBe(true);
      writeAuth(authFile);
    }
  });

  it("still refuses past the caps", async () => {
    const many = Array.from(
      { length: MAX_OWNER_SECRETS + 1 },
      (_, i) => `value-${String(i).padStart(8, "0")}`,
    );
    const { collect } = collector({ vault: () => many });
    await expect(collect.partial?.()).rejects.toMatchObject({ reason: "too_many" });
  });
});
