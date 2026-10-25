import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, type HandlerContext, type HandlerTable, type VaultUpdateRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { ReceiptStore } from "../../kernel/db/receipts.ts";
import { sha256Hex } from "../../kernel/ids.ts";
import { canonicalJson, createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { secretsRpc } from "./rpc.ts";
import { createSecrets, type SecretsDeps } from "./service.ts";
import { createVaultStore } from "./vault-store.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";

const ATLAS = "atlas-1a2b";
const BOLT = "bolt-0001";
const VALUE = "planted-secret-value-5c1e9a07";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bed(overrides: Partial<SecretsDeps> = {}) {
  const logs = captureLogger();
  const audit: unknown[] = [];
  const sent: Array<{ ownerId: string; agentId: string; record: VaultUpdateRecord }> = [];
  const root = join(dir, "vault");
  const vault = createVaultStore(root);
  const secrets = createSecrets({
    vault,
    agents: { get: (ownerId, agentId) => (ownerId === "u1" && [ATLAS, BOLT].includes(agentId) ? {} : null) },
    audit: { append: (line) => void audit.push(line) },
    sessions: {
      sendToAgent(ownerId, agentId, record) {
        sent.push({ ownerId, agentId, record });
        return 1;
      },
    },
    clock: createFakeClock(),
    logger: logs.logger,
    readOnly: false,
    ...overrides,
  });
  return { secrets, vault, logs, audit, sent, root };
}
const owner = testCaller();
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

describe("list", () => {
  it("returns names and times only", () => {
    const { secrets } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    const listed = secrets.list(owner, ATLAS);
    expect(listed).toEqual({ entries: [{ name: "API_TOKEN", updatedAt: expect.any(Number) }], state: "ok" });
    expect(JSON.stringify(listed)).not.toContain(VALUE);
  });

  it("an agent that is not the owner's is not_found, an empty one lists nothing", () => {
    const { secrets } = bed();
    expect(codeOf(() => secrets.list(testCaller({ userId: "u2" }), ATLAS))).toBe("not_found");
    expect(codeOf(() => secrets.list(owner, "ghost-0000"))).toBe("not_found");
    expect(secrets.list(owner, BOLT)).toEqual({ entries: [], state: "ok" });
  });

  it("a damaged vault lists no entry and says unreadable, with no error", () => {
    const { secrets, root } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    chmodSync(join(root, "u1", `agent-${ATLAS}.json`), 0o644);
    expect(secrets.list(owner, ATLAS)).toEqual({ entries: [], state: "unreadable" });
  });
});

describe("set and delete", () => {
  it("a set pushes vault_update to that agent's live workers with the whole scope, and to no other", () => {
    const { secrets, sent } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    secrets.set(owner, { agentId: ATLAS, name: "OTHER", value: "o" });
    secrets.set(owner, { agentId: BOLT, name: "BOLT_ONLY", value: "b" });
    expect(sent.map((call) => call.agentId)).toEqual([ATLAS, ATLAS, BOLT]);
    expect(sent[1]?.record).toEqual({
      type: "vault_update",
      vault: { API_TOKEN: VALUE, OTHER: "o" },
      once: [],
    });
    expect(sent[2]?.record.vault).toEqual({ BOLT_ONLY: "b" });
  });

  it("a delete pushes the rest, and a missing name is not_found with nothing pushed or audited", () => {
    const { secrets, sent, audit } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    secrets.set(owner, { agentId: ATLAS, name: "OTHER", value: "o" });
    sent.length = 0;
    audit.length = 0;
    secrets.remove(owner, { agentId: ATLAS, name: "API_TOKEN" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.record.vault).toEqual({ OTHER: "o" });
    expect(codeOf(() => secrets.remove(owner, { agentId: ATLAS, name: "NOPE" }))).toBe("not_found");
    expect(sent).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  it("writes an audit row per change: kind policy, info, agent, name and op, never the value", () => {
    const { secrets, audit } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    secrets.remove(owner, { agentId: ATLAS, name: "API_TOKEN" });
    expect(audit).toEqual([
      expect.objectContaining({
        ownerId: "u1",
        kind: "policy",
        reason: "secret set",
        detail: { agentId: ATLAS, name: "API_TOKEN", op: "set" },
      }),
      expect.objectContaining({
        kind: "policy",
        reason: "secret delete",
        detail: { agentId: ATLAS, name: "API_TOKEN", op: "delete" },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(VALUE);
    expect((audit[0] as { decision?: string }).decision).toBeUndefined();
  });

  it("a refused name never reaches the store, in either call", () => {
    const { secrets, vault, sent } = bed();
    const set = vi.spyOn(vault, "set");
    for (const name of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "HTTP_PROXY", "lower", "A".repeat(65)])
      expect(
        codeOf(() => secrets.set(owner, { agentId: ATLAS, name, value: "v" })),
        name,
      ).toBe("bad_request");
    expect(set).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("limit_reached at 50 names, with nothing pushed for the refused one", () => {
    const { secrets, sent } = bed();
    for (let n = 0; n < 50; n += 1) secrets.set(owner, { agentId: ATLAS, name: `NAME_${n}`, value: "v" });
    sent.length = 0;
    expect(codeOf(() => secrets.set(owner, { agentId: ATLAS, name: "ONE_MORE", value: "v" }))).toBe(
      "limit_reached",
    );
    expect(sent).toEqual([]);
  });

  it("another owner's agent is not_found and its vault is not touched", () => {
    const { secrets, vault } = bed();
    const other = testCaller({ userId: "u2" });
    expect(codeOf(() => secrets.set(other, { agentId: ATLAS, name: "API_TOKEN", value: "v" }))).toBe(
      "not_found",
    );
    expect(codeOf(() => secrets.remove(other, { agentId: ATLAS, name: "API_TOKEN" }))).toBe("not_found");
    expect(vault.names("u2", { kind: "agent", agentId: ATLAS })).toEqual([]);
  });

  it("a write to an unreadable vault is internal and logged once with the agent id only", () => {
    const { secrets, root, logs } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    chmodSync(join(root, "u1", `agent-${ATLAS}.json`), 0o644);
    expect(codeOf(() => secrets.set(owner, { agentId: ATLAS, name: "NEW_ONE", value: "v" }))).toBe(
      "internal",
    );
    expect(logs.lines.filter((line) => line.msg === "vault_unreadable")).toHaveLength(1);
    expect(logs.lines.find((line) => line.msg === "vault_unreadable")).toMatchObject({ agentId: ATLAS });
  });

  it("a read-only daemon refuses writes", () => {
    const { secrets } = bed({ readOnly: true });
    expect(codeOf(() => secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: "v" }))).toBe(
      "read_only",
    );
    expect(codeOf(() => secrets.remove(owner, { agentId: ATLAS, name: "API_TOKEN" }))).toBe("read_only");
  });

  it("a full disk is internal and the error says nothing of the value", () => {
    const failing = bed({});
    vi.spyOn(failing.vault, "set").mockImplementation(() => {
      throw Object.assign(new Error(`ENOSPC writing ${VALUE}`), { code: "ENOSPC" });
    });
    let thrown: unknown;
    try {
      failing.secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PapError);
    expect(JSON.stringify([String(thrown), failing.logs.lines])).not.toContain(VALUE);
  });

  it("a push that throws is logged and the set still succeeds", () => {
    const { secrets, logs } = bed({
      sessions: {
        sendToAgent() {
          throw new Error("worker gone");
        },
      },
    });
    expect(secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: "v" })).toEqual({});
    expect(logs.lines.some((line) => line.msg === "vault_update_not_sent")).toBe(true);
  });
});

describe("vaultOf (the worker's start)", () => {
  it("returns the decrypted scope of that agent only", () => {
    const { secrets } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    secrets.set(owner, { agentId: BOLT, name: "BOLT_ONLY", value: "b" });
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
    expect(secrets.vaultOf("u2", ATLAS)).toEqual({});
  });

  it("never reads the user scope", () => {
    const { secrets, vault } = bed();
    vault.set("u1", { kind: "user" }, "FORGE_TOKEN", "user-value", 1);
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({});
    expect(secrets.vaultOf("u1", "user")).toEqual({});
  });

  it("a damaged vault starts the worker with an empty one and logs once per agent until it reads again", () => {
    const { secrets, root, logs } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    const file = join(root, "u1", `agent-${ATLAS}.json`);
    chmodSync(file, 0o644);
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({});
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({});
    expect(logs.lines.filter((line) => line.msg === "vault_unreadable")).toHaveLength(1);
    chmodSync(file, 0o600);
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({ API_TOKEN: VALUE });
    chmodSync(file, 0o644);
    secrets.vaultOf("u1", ATLAS);
    expect(logs.lines.filter((line) => line.msg === "vault_unreadable")).toHaveLength(2);
  });
});

describe("drop", () => {
  it("removes the agent's scope and nothing of another's", () => {
    const { secrets, root } = bed();
    secrets.set(owner, { agentId: ATLAS, name: "API_TOKEN", value: VALUE });
    secrets.set(owner, { agentId: BOLT, name: "BOLT_ONLY", value: "b" });
    secrets.drop("u1", ATLAS);
    expect(readdirSync(join(root, "u1"))).toEqual([`agent-${BOLT}.json`]);
    expect(secrets.vaultOf("u1", ATLAS)).toEqual({});
  });
});

describe("a planted value reaches no log, event, audit row, file name or response (M11R58 style)", () => {
  it("the whole life of a secret", async () => {
    const { secrets, logs, audit, sent, root } = bed();
    const stored = new Map<string, { method: string; result: unknown }>();
    const receipts: ReceiptStore = {
      find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
      save: (userId, commandId, method, result) =>
        void stored.set(`${userId}:${commandId}`, { method, result }),
      purge: () => 0,
      readOnly: false,
    };
    const handlers = secretsRpc(secrets) as unknown as HandlerTable;
    const dispatch = createDispatcher({ gate: NO_CLIENT_PATHS, handlers, receipts, logger: logs.logger });
    const ctx: HandlerContext = {
      caller: owner,
      connectionId: "c1",
      openSubscription: () => "s",
      closeSubscription: () => {},
    };
    const responses = [
      await dispatch(
        {
          id: 1,
          method: "secrets.set",
          params: { agentId: ATLAS, name: "API_TOKEN", value: VALUE },
          commandId: "cmd-00000001",
        },
        ctx,
      ),
      await dispatch({ id: 2, method: "secrets.list", params: { agentId: ATLAS } }, ctx),
      // The failures too: a hijack name, a bad value, a damaged vault.
      await dispatch(
        {
          id: 3,
          method: "secrets.set",
          params: { agentId: ATLAS, name: "PATH", value: VALUE },
          commandId: "cmd-00000002",
        },
        ctx,
      ),
      await dispatch(
        {
          id: 4,
          method: "secrets.set",
          params: { agentId: ATLAS, name: "API_TOKEN", value: `${VALUE}\0` },
          commandId: "cmd-00000003",
        },
        ctx,
      ),
    ];
    chmodSync(join(root, "u1", `agent-${ATLAS}.json`), 0o644);
    responses.push(
      await dispatch(
        {
          id: 5,
          method: "secrets.set",
          params: { agentId: ATLAS, name: "OTHER", value: VALUE },
          commandId: "cmd-00000004",
        },
        ctx,
      ),
      await dispatch({ id: 6, method: "secrets.list", params: { agentId: ATLAS } }, ctx),
    );
    secrets.vaultOf("u1", ATLAS);
    expect(responses.map((response) => response.ok)).toEqual([true, true, false, false, false, true]);
    // The legitimate push to the worker is the one place a value goes (a frame to a sandboxed process).
    expect(JSON.stringify(sent[0]?.record)).toContain(VALUE);
    const evidence = JSON.stringify({
      logs: logs.lines,
      audit,
      responses,
      receipts: [...stored.values()],
      files: readdirSync(join(root, "u1")),
      key: readFileSync(join(root, "key")).toString("base64"),
    });
    expect(evidence).not.toContain(VALUE);
    expect(evidence).not.toContain(Buffer.from(VALUE).toString("base64"));
    // The receipt keeps the selector hash of the agent and the name, never of the value.
    const receiptDump = JSON.stringify([...stored.values()]);
    expect(receiptDump).not.toContain(sha256Hex(canonicalJson({ value: VALUE })));
    expect(receiptDump).not.toContain(sha256Hex(VALUE));
  });
});

describe("through the dispatcher", () => {
  it("a token is forbidden for list, set and delete and nothing changes", async () => {
    const { secrets, vault } = bed();
    const handlers = secretsRpc(secrets) as unknown as HandlerTable;
    const receipts: ReceiptStore = { find: () => null, save: () => {}, purge: () => 0, readOnly: false };
    const dispatch = createDispatcher({
      gate: NO_CLIENT_PATHS,
      handlers,
      receipts,
      logger: captureLogger().logger,
    });
    const token = testCaller({
      kind: "token",
      credentialId: "tok1",
      permissions: new Set(["agents:read", "sessions:read", "sessions:operate", "agents:operate"]),
    });
    const ctx: HandlerContext = {
      caller: token,
      connectionId: "c1",
      openSubscription: () => "s",
      closeSubscription: () => {},
    };
    for (const [method, params] of [
      ["secrets.list", { agentId: ATLAS }],
      ["secrets.set", { agentId: ATLAS, name: "API_TOKEN", value: "v" }],
      ["secrets.delete", { agentId: ATLAS, name: "API_TOKEN" }],
    ] as const) {
      const response = await dispatch({ id: 1, method, params, commandId: "cmd-00000009" }, ctx);
      expect(response, method).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(vault.names("u1", { kind: "agent", agentId: ATLAS })).toEqual([]);
  });
});
