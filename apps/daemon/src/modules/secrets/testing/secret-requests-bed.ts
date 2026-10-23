import { join } from "node:path";
import { PLATFORM_ARGS, type VaultUpdateRecord } from "@pap/contracts";
import { vi } from "vitest";
import { createRequestsBed, type RequestsBed } from "../../agents/testing/requests-bed.ts";
import type { PlatformContext } from "../../platform/index.ts";
import { createOnceStore, createSecretRequests, createSecrets, createVaultStore } from "../index.ts";

export const VALUE = "planted-secret-value-5c1e9a07";
export const SALT = Buffer.alloc(32, 9);
export const MIN = 60_000;

/** The beds `setup` made in the running test: its `afterEach` disposes them all. */
const beds: RequestsBed[] = [];
export function disposeBeds(): void {
  for (const bed of beds.splice(0)) bed.bed.dispose();
}

export interface Sent {
  readonly agentId: string;
  readonly record: VaultUpdateRecord;
  readonly sessionId: string | undefined;
}

export async function setup(options: { sandboxed?: boolean; auditFails?: boolean } = {}) {
  const t = await createRequestsBed();
  beds.push(t);
  const sent: Sent[] = [];
  const warnings: unknown[] = [];
  const sessions = {
    sandboxed: vi.fn(() => options.sandboxed ?? true),
    sendToAgent: vi.fn((_owner: string, agentId: string, record: VaultUpdateRecord, sessionId?: string) => {
      sent.push({ agentId, record, sessionId });
      return 1;
    }),
  };
  const vault = createVaultStore(join(t.bed.dir, "vault"));
  const logger = {
    warn: (...rest: unknown[]) => void warnings.push(rest),
    error: () => {},
    info: () => {},
    debug: () => {},
  };
  const secrets = createSecrets({
    vault,
    agents: t.bed.agents.port,
    audit: t.bed.audit,
    sessions,
    clock: t.bed.clock,
    logger: logger as never,
    readOnly: false,
  });
  const once = createOnceStore(() => t.bed.clock.now());
  const audit = options.auditFails
    ? {
        append: () => {
          throw new Error(`audit down ${VALUE}`);
        },
      }
    : t.bed.audit;
  const secretRequests = createSecretRequests({
    requests: t.requests,
    secrets,
    once,
    salt: () => SALT,
    sessions,
    clock: t.bed.clock,
    audit,
    logger: logger as never,
    readOnly: false,
  });
  const ctx = (signal: AbortSignal, over: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "t1",
    type: "agent-thread",
    tainted: false,
    agentId: t.agentId,
    signal,
    ...over,
  });
  const ask = (
    args: { name?: string; reason?: string } = {},
    over: Partial<PlatformContext> = {},
    controller = new AbortController(),
  ) => {
    const promise = secretRequests.op(
      PLATFORM_ARGS["secret.request"].parse({
        name: "GRAFANA_TOKEN",
        reason: "to read the dashboards",
        ...args,
      }),
      ctx(controller.signal, over),
    );
    const settled: { value?: unknown; error?: unknown } = {};
    promise.then(
      (value) => (settled.value = value),
      (error: unknown) => (settled.error = error),
    );
    return { promise, controller, settled };
  };
  const pendingId = (): string =>
    t.bed.db.get<{ id: string }>(
      "SELECT id FROM agent_requests WHERE state = 'pending' ORDER BY created_at DESC",
    )?.id ?? "";
  return { t, secretRequests, secrets, vault, once, sent, warnings, sessions, ask, pendingId };
}

export const dumpOf = (s: Awaited<ReturnType<typeof setup>>): string => {
  const { t } = s;
  return JSON.stringify([
    t.bed.auditRows(),
    t.bed.logs,
    t.upserts,
    t.resolved,
    t.changed,
    t.bed.db.all("SELECT * FROM agent_requests"),
    s.warnings,
  ]);
};
