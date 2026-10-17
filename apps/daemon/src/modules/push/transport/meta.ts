import { PUSH_FAILURE_REASONS } from "@pap/contracts";
import { z } from "zod";
import type { Db } from "../../../kernel/db/database.ts";

const KeysReset = z.object({ at: z.number().int(), purged: z.number().int().min(0) }).strict();
const LastFailure = z.object({ at: z.number().int(), reason: z.enum(PUSH_FAILURE_REASONS) });

export type KeysReset = z.infer<typeof KeysReset>;
export type LastFailure = z.infer<typeof LastFailure>;

function read<T>(db: Db, key: string, schema: z.ZodType<T>): T | null {
  const row = db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = $key", { key });
  if (row === undefined) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null; // a damaged or unknown row is shown as nothing, never as content
  } catch {
    return null;
  }
}

/**
 * `push_meta`: `keys_reset` is written here (boot) and cleared by the next subscription; `last_failure:<ownerId>` is
 * written by the delivery side (task 9a, W6-R6) and only read here.
 */
export function createPushMeta(db: Db) {
  return {
    keysReset: (): KeysReset | null => read(db, "keys_reset", KeysReset),
    setKeysReset(value: KeysReset): void {
      db.run("INSERT OR REPLACE INTO push_meta (key, value) VALUES ('keys_reset', $value)", {
        value: JSON.stringify(value),
      });
    },
    lastFailure: (ownerId: string): LastFailure | null => read(db, `last_failure:${ownerId}`, LastFailure),
  };
}
export type PushMeta = ReturnType<typeof createPushMeta>;
