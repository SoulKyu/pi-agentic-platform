import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import type { AgentsBed } from "./bed.ts";

/** Small readers the agents service tests share, over whichever bed is current. */
export function bedHelpers(current: () => AgentsBed) {
  const refusalOf = async (fn: () => unknown): Promise<string> => {
    try {
      await fn();
    } catch (error) {
      return error instanceof PapError ? error.code : `other: ${String(error)}`;
    }
    return "no error";
  };
  return {
    modeOf: (path: string): number => statSync(path).mode & 0o777,
    refusalOf,
    homesOf: (): string[] =>
      readdirSync(join(current().papHome, "agents")).filter((name) => !name.startsWith(".")),
    rowCount: (): number => current().db.get<{ n: number }>("SELECT count(*) AS n FROM agents")?.n ?? 0,
    /** Rows that do not parse as a profile: they count against the limit and read `unreadable`. */
    insertRows(count: number, ownerId = "u1"): void {
      for (let n = 0; n < count; n += 1)
        current().db.run(
          `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
           VALUES ($id, $ownerId, $name, $name, '{}', 1, 1)`,
          { id: `bulk-${n.toString(16).padStart(4, "0")}`, ownerId, name: `bulk${n}` },
        );
    },
  };
}
