import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandlerContext } from "@pap/contracts";
import { type Clock, createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { type AuditPort, AUDIT_MIGRATIONS } from "../../audit/index.ts";
import { SESSIONS_MIGRATIONS } from "../../sessions/index.ts";
import { POLICY_MIGRATIONS } from "../index.ts";

export const KEY = "a".repeat(64);

/** Grant keys are 64 hex characters; `n` makes distinct ones. */
export const keyOf = (n: number): string => n.toString(16).padStart(64, "0");

/** A real database in a temp dir, a fake clock that moves one millisecond per rule, and a logger that keeps its lines. */
export function createPolicyBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-policy-"));
  const clock = createFakeClock();
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, POLICY_MIGRATIONS, AUDIT_MIGRATIONS],
    clock,
    logger: createLogger({ level: "error", clock, write: () => {} }),
  }).db;
  const lines: Array<Record<string, unknown>> = [];
  const logger: Logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  let counter = 0;
  const newId = () => `r${++counter}`;
  const audited: Array<Parameters<AuditPort["append"]>[0]> = [];
  const audit: Pick<AuditPort, "append"> = { append: (line) => void audited.push(line) };
  return {
    db,
    clock,
    logger,
    newId,
    audit,
    audited,
    lines,
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface PolicyBedParts {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: Pick<AuditPort, "append">;
  newId(): string;
}

/**
 * A policy service and its rpc over a real database; `changes` records every listener call as `owner:scope`. A bed may
 * not import a module's internals, so the test passes `make`, which builds the service and its rpc from the parts.
 */
export function policyBed<
  Service extends { onChange(listener: (ownerId: string, scope: string) => void): unknown },
  Rpc,
>(make: (parts: PolicyBedParts) => { service: Service; rpc: Rpc }) {
  const bed = createPolicyBed();
  const { service, rpc } = make(bed);
  const changes: string[] = [];
  service.onChange((ownerId, scope) => void changes.push(`${ownerId}:${scope}`));
  const ctxOf = (userId: string): HandlerContext => ({
    caller: testCaller({ userId }),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  });
  return { ...bed, service, rpc, changes, ctxOf };
}

export interface SessionPolicyBedParts extends PolicyBedParts {
  readonly audit: AuditPort;
  sessionOwner(sessionId: string): string | null;
}

/**
 * The v2 service (session modes, taint, owner settings) over a real database, a fake sessions lookup (sessions `s1` and
 * `s2` of `u1`) and a fake audit port. A bed may not import a module's internals, so the test passes `make`.
 */
export function sessionPolicyBed<
  Service extends {
    onSessionChange(listener: (ownerId: string, sessionId: string) => void): unknown;
    onSettingsChange(listener: (ownerId: string) => void): unknown;
  },
  Rpc,
>(make: (parts: SessionPolicyBedParts) => { service: Service; rpc: Rpc }) {
  const bed = createPolicyBed();
  const owners = new Map<string, string>();
  /** Inserts a sessions row (the columns the sessions store writes) and lets the fake lookup know its owner. */
  const addSession = (id: string, ownerId: string) => {
    bed.db.run(
      "INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, created_at, updated_at) VALUES ($id, NULL, NULL, '/w', $ownerId, NULL, 1, 1)",
      { id, ownerId },
    );
    owners.set(id, ownerId);
  };
  addSession("s1", "u1");
  addSession("s2", "u1");
  const audits: Array<Parameters<AuditPort["append"]>[0]> = [];
  const { service, rpc } = make({
    ...bed,
    audit: { append: (line) => void audits.push(line), fromWorker: () => null },
    sessionOwner: (sessionId) => owners.get(sessionId) ?? null,
  });
  const changes: string[] = [];
  const settingsChanges: string[] = [];
  service.onSessionChange((ownerId, sessionId) => void changes.push(`${ownerId}:${sessionId}`));
  service.onSettingsChange((ownerId) => void settingsChanges.push(ownerId));
  const ctxOf = (userId: string): HandlerContext => ({
    caller: testCaller({ userId }),
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  });
  return { ...bed, service, rpc, audits, changes, settingsChanges, addSession, ctxOf };
}
