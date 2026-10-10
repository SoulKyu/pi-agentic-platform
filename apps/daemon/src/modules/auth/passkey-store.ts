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

type RawPasskey = Omit<PasskeyRow, "transports"> & { transports: string };
const toPasskey = (row: RawPasskey): PasskeyRow => ({
  ...row,
  transports: JSON.parse(row.transports) as string[],
});
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
