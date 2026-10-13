import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { sha256Hex } from "../../../kernel/ids.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import type { AuditPort } from "../../audit/index.ts";
import { AUTH_MIGRATIONS, createAuthTestHarness } from "../index.ts";

export const OWNER_ID = "owner-1";
export const OTHER_ID = "other-1";
export const CRED_A = "cred-a";
export const CRED_B = "cred-b";
export const CRED_OTHER = "cred-other";
export const T0 = 1_000;
export const T1 = 2_000;
export const T2 = 3_000;
export const shortId = (credentialId: string): string => sha256Hex(credentialId).slice(0, 32);

/** A real database: the owner with passkeys A and B, a second user with one, and a manager over the real services. */
export function createPasskeyBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-passkeys-"));
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
  const audited: Array<Parameters<AuditPort["append"]>[0]> = [];
  const audit = { append: (line: Parameters<AuditPort["append"]>[0]) => void audited.push(line) };
  const { store, service, stepUps, passkeys } = createAuthTestHarness({ db, clock, audit });
  for (const [id, userId, transports, createdAt, lastUsedAt] of [
    [CRED_A, OWNER_ID, ["internal"], T0, null],
    [CRED_B, OWNER_ID, ["usb", "nfc"], T1, T2],
    [CRED_OTHER, OTHER_ID, ["hybrid"], T2, null],
  ] as const) {
    store.insertPasskey({
      id,
      userId,
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [...transports],
      createdAt,
    });
    db.run("UPDATE passkeys SET last_used_at = $lastUsedAt WHERE id = $id", { id, lastUsedAt });
  }
  return {
    db,
    clock,
    store,
    service,
    stepUps,
    manager: passkeys,
    audited,
    owner: testCaller({ userId: OWNER_ID }),
    confirmed: () => testCaller({ userId: OWNER_ID, stepUpUntil: clock.now() + 1000 }),
    rows: (): string[] =>
      db.all<{ id: string }>("SELECT id FROM passkeys ORDER BY created_at, id").map((row) => row.id),
    sessionsOf: (userId: string): string[] =>
      db
        .all<{ id: string }>("SELECT public_id AS id FROM auth_sessions WHERE user_id = $userId", { userId })
        .map((row) => row.id),
    startSession(origin: { method: "password" | "passkey"; passkeyRef?: string }) {
      const started = service.startSession(OWNER_ID, "curl/8", { ip: "10.0.0.1", ...origin });
      const idHash = sha256Hex(started.cookieValue);
      const publicId = db.get<{ id: string }>(
        "SELECT public_id AS id FROM auth_sessions WHERE id_hash = $idHash",
        {
          idHash,
        },
      )?.id;
      return { ...started, idHash, publicId: publicId ?? "" };
    },
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
