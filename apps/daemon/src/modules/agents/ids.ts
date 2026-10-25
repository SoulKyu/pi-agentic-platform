import { randomBytes } from "node:crypto";
import { AgentId, slugOf } from "@pap/contracts";

/** The vault names an agent's scope file `agent-<id>.json`, and its id may be 48 characters at most. */
const ID_MAX = 48;

/** 4 random bytes (RT-19): an id of a trashed agent is not met by chance, and `store.exists` also reads the trash. */
export const randomAgentHex = (): string => randomBytes(4).toString("hex");

/** `<slug>-<hex>`, the slug cut so the whole id fits the vault scope name; null when it is not an agent id. */
export function agentIdOf(name: string, hex: string): string | null {
  const slug = slugOf(name)
    .slice(0, ID_MAX - 1 - hex.length)
    .replace(/-+$/g, "");
  const id = `${slug}-${hex}`;
  return AgentId.safeParse(id).success ? id : null;
}
