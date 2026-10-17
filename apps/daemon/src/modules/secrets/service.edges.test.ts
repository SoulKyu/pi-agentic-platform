import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, type VaultUpdateRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createSecrets } from "./service.ts";
import { createVaultStore } from "./vault-store.ts";

const ATLAS = "atlas-1a2b";
const BOLT = "bolt-0001";
const owner = testCaller();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-secrets-edges-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bed() {
  const logs = captureLogger();
  const sent: VaultUpdateRecord[] = [];
  const root = join(dir, "vault");
  const vault = createVaultStore(root);
  const secrets = createSecrets({
    vault,
    agents: { get: () => ({}) },
    audit: { append: () => undefined },
    sessions: { sendToAgent: (_owner, _agent, record) => (sent.push(record), 1) },
    clock: createFakeClock(),
    logger: logs.logger,
    readOnly: false,
  });
  return { secrets, vault, logs, sent, root };
}
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

describe("a lost key", () => {
  it("lists an empty scope, and a set says command_failed (not internal) and logs it", () => {
    const { secrets, logs, root } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: "v" });
    renameSync(join(root, "key"), join(dir, "key.saved"));
    expect(secrets.list(owner, BOLT)).toEqual({ entries: [], state: "ok" });
    expect(secrets.list(owner, ATLAS)).toEqual({ entries: [], state: "unreadable" });
    expect(codeOf(() => secrets.set(owner, { agentId: BOLT, name: "NEW_ONE", value: "v" }))).toBe(
      "command_failed",
    );
    expect(logs.lines.filter((line) => line.msg === "vault_key_lost")).toEqual([
      expect.objectContaining({ agentId: BOLT }),
    ]);
  });
});

describe("the push to the live workers", () => {
  it("sends nothing when a value is longer than the contract allows, and logs it", () => {
    const { secrets, vault, logs, sent } = bed();
    vi.spyOn(vault, "reveal").mockReturnValue({ API_TOKEN: "x".repeat(5000) });
    expect(secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: "v" })).toEqual({});
    expect(sent).toEqual([]);
    expect(logs.lines.some((line) => line.msg === "vault_update_invalid")).toBe(true);
  });

  it("sends the whole scope when every value is within the caps", () => {
    const { secrets, sent } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: "x".repeat(4096) });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.vault.API_TOKEN).toHaveLength(4096);
  });
});
