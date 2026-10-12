import type { Db } from "../../kernel/db/database.ts";
import { sha256Hex } from "../../kernel/ids.ts";

export interface PasskeyRow {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: string[];
}

/** A passkey as the list reads it: `id` is the credential id, which the manager turns into the short id before showing it. */
export interface PasskeyListing {
  readonly id: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly transports: string[];
}

export interface PasskeyStore {
  listPasskeys(userId: string): PasskeyRow[];
  /** Newest first (ties: the later insert), at most `limit`: a passkey added last is never cut off. */
  listPasskeyListings(userId: string, limit: number): PasskeyListing[];
  findPasskey(id: string): PasskeyRow | undefined;
  insertPasskey(row: PasskeyRow & { readonly createdAt: number }): void;
  /** The counter after a sign-in, and when it happened. */
  updatePasskeyCounter(id: string, counter: number, usedAt: number): void;
}

/** The short id of a passkey (M5R128): the first 32 hex characters of the sha256 of its credential id. */
export const passkeyRefOf = (credentialId: string): string => sha256Hex(credentialId).slice(0, 32);

const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set([
  "usb",
  "nfc",
  "ble",
  "hybrid",
  "internal",
  "smart-card",
  "cable",
]);

/** Only the transports WebAuthn defines survive: a registration response is client input, and the column is read back into options. */
export function sanitizeTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const known = value.filter(
    (item): item is string => typeof item === "string" && KNOWN_TRANSPORTS.has(item),
  );
  return [...new Set(known)];
}

function readTransports(raw: string): string[] {
  try {
    return sanitizeTransports(JSON.parse(raw));
  } catch {
    return [];
  }
}

type RawPasskey = Omit<PasskeyRow, "transports"> & { transports: string };
const toPasskey = (row: RawPasskey): PasskeyRow => ({ ...row, transports: readTransports(row.transports) });
const COLUMNS = "id, user_id AS userId, public_key AS publicKey, counter, transports";

export function createPasskeyStore(db: Db): PasskeyStore {
  return {
    listPasskeys: (userId) =>
      db
        .all<RawPasskey>(`SELECT ${COLUMNS} FROM passkeys WHERE user_id = $userId ORDER BY created_at, id`, {
          userId,
        })
        .map(toPasskey),
    listPasskeyListings: (userId, limit) =>
      db
        .all<Omit<PasskeyListing, "transports"> & { transports: string }>(
          "SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt, transports FROM passkeys WHERE user_id = $userId ORDER BY created_at DESC, rowid DESC LIMIT $limit",
          { userId, limit },
        )
        .map((row) => ({ ...row, transports: readTransports(row.transports) })),
    findPasskey: (id) => {
      const row = db.get<RawPasskey>(`SELECT ${COLUMNS} FROM passkeys WHERE id = $id`, { id });
      return row ? toPasskey(row) : undefined;
    },
    insertPasskey: (row) => {
      db.run(
        "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($id, $userId, $publicKey, $counter, $transports, $createdAt)",
        {
          id: row.id,
          userId: row.userId,
          publicKey: row.publicKey,
          counter: row.counter,
          transports: JSON.stringify(row.transports),
          createdAt: row.createdAt,
        },
      );
    },
    updatePasskeyCounter: (id, counter, usedAt) => {
      db.run("UPDATE passkeys SET counter = $counter, last_used_at = $usedAt WHERE id = $id", {
        id,
        counter,
        usedAt,
      });
    },
  };
}
