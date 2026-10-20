import { readFileSync } from "node:fs";

export const CONFIG_PATH = "/etc/pap-vm/config.json";

export interface VmdConfig {
  readonly papUid: number;
  readonly papGid: number;
  readonly papHome: string;
}

const isId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) < 2 ** 31;

/**
 * `pap vm setup` writes `{ papUid, papGid, papHome }` (R36). Fails closed: a missing file, bad JSON, a uid of root (0) or a
 * relative home stops pap-vmd, since the socket's owner and the state folder both come from here.
 */
export function parseVmdConfig(text: string): VmdConfig {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("vmd config: not an object");
  const { papUid, papGid, papHome } = raw as Record<string, unknown>;
  if (!isId(papUid) || !isId(papGid))
    throw new Error("vmd config: papUid and papGid must be positive integers");
  if (typeof papHome !== "string" || !papHome.startsWith("/") || papHome.includes("\0")) {
    throw new Error("vmd config: papHome must be an absolute path");
  }
  return { papUid, papGid, papHome };
}

export const loadVmdConfig = (file: string = CONFIG_PATH): VmdConfig =>
  parseVmdConfig(readFileSync(file, "utf8"));
