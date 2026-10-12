import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { sha256Hex } from "../../../kernel/ids.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import type { AuditPort } from "../../audit/index.ts";
import {
  AUTH_MIGRATIONS,
  createAuthService,
  createAuthStore,
  createAuthThrottles,
  createDevices,
  createSetupToken,
} from "../index.ts";

export const OWNER_ID = "owner-1";
export const OTHER_ID = "other-1";
const HOUR = 3_600_000;

/** A real database: an owner with three browser sessions (the newest is the caller's), and a second user with one. */
export function createDeviceBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-devices-"));
  const clock = createFakeClock();
  let db;
  try {
    db = migrate({
      dbPath: join(dir, "s.db"),
      backupsDir: join(dir, "b"),
      sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
      clock,
      logger: silentLogger,
    }).db;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  for (const [id, name] of [
    [OWNER_ID, "owner"],
    [OTHER_ID, "other"],
  ] as const) {
    db.run("INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, $name, 'x', 0)", {
      id,
      name,
    });
  }
  const store = createAuthStore(db);
  const t0 = clock.now();
  const cookies: Record<string, string> = {};
  const add = (key: string, userId: string, publicId: string, age: number, extra: object) => {
    cookies[key] = `cookie-${key}`;
    store.insertSession({
      idHash: sha256Hex(`cookie-${key}`),
      publicId,
      userId,
      createdAt: t0 - age,
      lastSeenAt: t0 - age,
      expiresAt: t0 + 30 * 24 * HOUR,
      userAgent: "curl/8.5.0",
      ip: null,
      method: null,
      passkeyRef: null,
      ...extra,
    });
  };
  const ID = (n: string) => n.repeat(32).slice(0, 32);
  add("current", OWNER_ID, ID("a"), 0, { method: "passkey", passkeyRef: "p".repeat(32), ip: "10.0.0.1" });
  add("second", OWNER_ID, ID("b"), HOUR, { method: "password", ip: "10.0.0.2" });
  add("third", OWNER_ID, ID("c"), 2 * HOUR, { method: "setup" });
  add("foreign", OTHER_ID, ID("d"), 0, { method: "password" });
  const audited: Array<Parameters<AuditPort["append"]>[0]> = [];
  const audit = { append: (line: Parameters<AuditPort["append"]>[0]) => void audited.push(line) };
  const throttles = createAuthThrottles(clock);
  const service = createAuthService({
    store,
    clock,
    logger: silentLogger,
    publicOrigin: "http://localhost:7777",
    throttle: throttles.password,
    sessionThrottle: throttles.session,
    setupToken: createSetupToken(false),
    audit,
  });
  const devices = createDevices({ store, service, clock, audit });
  return {
    db,
    clock,
    store,
    service,
    devices,
    audited,
    cookies,
    current: testCaller({ userId: OWNER_ID, credentialId: ID("a") }),
    other: { deviceId: ID("d") },
    publicIds: { current: ID("a"), second: ID("b"), third: ID("c") },
    sessionsOf: (userId: string): string[] =>
      db
        .all<{ id: string }>(
          "SELECT public_id AS id FROM auth_sessions WHERE user_id = $userId ORDER BY created_at DESC",
          { userId },
        )
        .map((row) => row.id),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
