import type { Db } from "../../kernel/db/database.ts";

export interface PasskeyRow {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: string[];
}

export interface PasskeyStore {
  listPasskeys(userId: string): PasskeyRow[];
  findPasskey(id: string): PasskeyRow | undefined;
  insertPasskey(row: PasskeyRow & { readonly createdAt: number }): void;
  updatePasskeyCounter(id: string, counter: number): void;
}

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
    updatePasskeyCounter: (id, counter) => {
      db.run("UPDATE passkeys SET counter = $counter WHERE id = $id", { id, counter });
    },
  };
}
