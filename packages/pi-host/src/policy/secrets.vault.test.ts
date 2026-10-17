import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OnceValues, VAULT_CAPS } from "@pap/contracts";
import type { CallFacts } from "./pipeline.ts";
import { restoreInput } from "./restore.ts";
import { createSecretSource, ONCE_MAX } from "./secrets.ts";
import { classifyTool } from "./tool-kind.ts";

const VAULT = { VAULT_TOKEN: "vault-0123456789", SHORT: "abcdefg" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function source(env: NodeJS.ProcessEnv = {}, auth?: object) {
  const agentDir = mkdtempSync(join(tmpdir(), "pap-vault-"));
  dirs.push(agentDir);
  if (auth) writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
  return createSecretSource({ env, agentDir });
}

describe("the vault in the redactor (M11R26)", () => {
  it("turns a vault value of 8 or more characters into [SECRET:NAME]", () => {
    const secrets = source();
    secrets.setVault(VAULT);
    expect(secrets.current().text("token=vault-0123456789;").text).toBe("token=[SECRET:VAULT_TOKEN];");
  });

  it("does not redact a 7-character value (M5R35's floor)", () => {
    const secrets = source();
    secrets.setVault(VAULT);
    expect(secrets.current().text("x abcdefg y").text).toBe("x abcdefg y");
  });

  it("redacts a weak-looking value too: the owner chose to keep it secret", () => {
    const secrets = source();
    secrets.setVault({ PLAIN_WORD: "abcdefgh", ZEROES: "00000000" });
    expect(secrets.current().text("abcdefgh 00000000").text).toBe("[SECRET:PLAIN_WORD] [SECRET:ZEROES]");
  });

  it("keeps the vault name when an environment secret has the same name or the same value", () => {
    const secrets = source({ VAULT_TOKEN: "env-0123456789", OTHER_TOKEN: "vault-0123456789" });
    secrets.setVault(VAULT);
    expect(secrets.current().text("vault-0123456789 env-0123456789").text).toBe(
      "[SECRET:VAULT_TOKEN] [SECRET:VAULT_TOKEN_2]",
    );
  });

  it("never restores a vault marker into a write or an edit (M5R35's restoration stays environment-sourced)", () => {
    const secrets = source({ DB_TOKEN: "env-0123456789" });
    secrets.setVault(VAULT);
    expect([...secrets.current().restorable().keys()]).toEqual(["DB_TOKEN"]);
    const input = { path: "a", content: "x=[SECRET:VAULT_TOKEN] y=[SECRET:DB_TOKEN]" };
    const call = {
      event: { toolCallId: "c", toolName: "write", input },
      kind: classifyTool("write", { path: "builtin:write" }),
    } as CallFacts;
    expect(restoreInput(call, secrets.current().restorable())).toBe(1);
    expect(input.content).toBe("x=[SECRET:VAULT_TOKEN] y=env-0123456789");
  });

  it("keeps the vault when auth.json is read or changes later", () => {
    const secrets = source({}, { openai: { access: "at-0123456789" } });
    secrets.setVault(VAULT);
    secrets.refresh();
    expect(secrets.current().text("at-0123456789 vault-0123456789").text).toBe(
      "[SECRET:AUTH_OPENAI_ACCESS] [SECRET:VAULT_TOKEN]",
    );
  });

  it("a vault_update that adds a name redacts it at once, and the old one still", () => {
    const secrets = source();
    secrets.setVault(VAULT);
    secrets.setVault({ ...VAULT, NEW_NAME: "brand-new-value" });
    expect(secrets.current().text("brand-new-value vault-0123456789").text).toBe(
      "[SECRET:NEW_NAME] [SECRET:VAULT_TOKEN]",
    );
  });

  it("a vault_update that removes a name keeps redacting its last value until the worker restarts (documented)", () => {
    const secrets = source();
    secrets.setVault(VAULT);
    secrets.setVault({});
    // The value may already sit in the model's context or in a file; forgetting it would only help a leak.
    expect(secrets.current().text("vault-0123456789").text).toBe("[SECRET:VAULT_TOKEN]");
    // A worker that starts later has never seen it.
    expect(source().current().text("vault-0123456789").text).toBe("vault-0123456789");
  });

  it("a renamed value keeps the name it had when it was last live", () => {
    const secrets = source();
    secrets.setVault({ OLD_NAME: "vault-0123456789" });
    secrets.setVault({ NEW_NAME: "vault-0123456789" });
    expect(secrets.current().text("vault-0123456789").text).toBe("[SECRET:NEW_NAME]");
  });

  it("never lets the 256-secret cap of the environment drop a vault value", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 300; i++)
      env[`SERVICE_${i}_TOKEN`] = `environment-value-${String(i).padStart(4, "0")}-long`;
    const secrets = source(env);
    secrets.setVault({ SHORT_LIVED: "vault-12345678" });
    expect(secrets.current().text("vault-12345678").text).toBe("[SECRET:SHORT_LIVED]");
  });

  it("forgets the oldest retired values past 128, and the pinned ones never push a credential out of the 256 slots", () => {
    const value = (i: number) => `rotated-value-${String(i).padStart(4, "0")}-long`;
    const ROTATING = /^\[SECRET:ROTATING(_\d+)?\]$/;
    const secrets = source({ PAP_WORKER_TOKEN: "worker-token-value-0123456789" });
    for (let i = 0; i < 300; i++) secrets.setVault({ ROTATING: value(i) });
    const text = secrets.current().text.bind(secrets.current());
    // The live value and the newest retired ones stay redacted, the oldest were forgotten.
    expect(text(value(299)).text).toMatch(ROTATING);
    expect(text(value(299 - 128)).text).toMatch(ROTATING);
    expect(text(value(299 - 129)).text).toBe(value(299 - 129));
    expect(text(value(0)).text).toBe(value(0));
    // The contract's largest vault and one-use list on top of the retired values still leave room for 75 environment credentials.
    const full = source(
      Object.fromEntries(
        Array.from({ length: 75 }, (_, i) => [
          `SERVICE_${i}_TOKEN`,
          `environment-value-${String(i).padStart(4, "0")}-long`,
        ]),
      ),
    );
    for (let i = 0; i < 300; i++) full.setVault({ ROTATING: value(i) });
    full.setVault(
      Object.fromEntries(
        Array.from({ length: VAULT_CAPS.names }, (_, i) => [
          `NAME_${i}`,
          `vault-value-${String(i).padStart(4, "0")}-long`,
        ]),
      ),
    );
    full.setOnce(
      Array.from({ length: ONCE_MAX }, (_, n) => ({ name: "ONCE", value: `once-value-${n}-0123456789` })),
    );
    const redactor = full.current();
    expect(redactor.entries).toHaveLength(256);
    for (let i = 0; i < 75; i++) {
      const secret = `environment-value-${String(i).padStart(4, "0")}-long`;
      expect(redactor.text(secret).count, secret).toBe(1);
    }
    expect(redactor.text(value(299)).count).toBe(1);
  });

  it("keeps the one-use maximum it budgets for equal to the contract's", () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: "ONCE", value: "v", expiresAt: 1 }));
    expect(OnceValues.safeParse(list(ONCE_MAX)).success).toBe(true);
    expect(OnceValues.safeParse(list(ONCE_MAX + 1)).success).toBe(false);
  });
});
