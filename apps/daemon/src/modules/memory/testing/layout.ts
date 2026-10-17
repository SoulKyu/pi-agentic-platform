import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FACT = "123e4567-e89b-42d3-a456-426614174000";
export const FACT2 = "223e4567-e89b-42d3-a456-426614174000";
export const AGENT = "atlas-1a2b";

/** A temporary pi-mem0 folder (never the real one); `mem0` is its absolute path. */
export function createMem0Layout() {
  const root = mkdtempSync(join(tmpdir(), "pap-mem0-"));
  const mem0 = join(root, "mem0");
  mkdirSync(mem0, { mode: 0o700 });
  const dir = (name: string): string => {
    const path = join(mem0, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const json = (relative: string, value: unknown): string => {
    const path = join(mem0, relative);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const fact = (id: string, over: Record<string, unknown> = {}): string =>
    json(`staging/${id}.json`, {
      id,
      agent: AGENT,
      text: "likes tea",
      sourceSession: "session-1",
      createdAt: "2026-10-16T08:00:00.000Z",
      ...over,
    });
  return { root, mem0, dir, json, fact, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
export type Mem0Layout = ReturnType<typeof createMem0Layout>;
