import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAppend } from "@pap/contracts";

/** The agent and file every mirror test uses. */
export const AGENT = "atlas-1a2b";
export const FILE = "2026-10-19T10-00-00-000Z_0f6c0f2e.jsonl";

export const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "hdr00001", timestamp: "2026-10-19T10:00:00.000Z", cwd: "/agent" })}\n`;

/** A Pi entry line as Pi writes it: `type` and `id` first. */
export const entry = (id: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-19T10:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }] },
    ...extra,
  })}\n`;

export const userEntry = (id: string, content: unknown): string =>
  entry(id, { message: { role: "user", content } });

/** A user line carrying `bytes` of an image: a line over the inline bound. */
export const imageEntry = (id: string, bytes: number): string =>
  userEntry(id, [
    { type: "text", text: "look" },
    { type: "image", data: "A".repeat(bytes), mimeType: "image/png" },
  ]);

export const appendOf = (
  offset: number,
  data: string | Buffer,
  options: { replace?: boolean; file?: string } = {},
): SessionAppend => ({
  type: "session_append",
  file: options.file ?? FILE,
  offset,
  data: Buffer.from(data).toString("base64"),
  replace: options.replace ?? false,
});

export interface Bed {
  readonly root: string;
  readonly folder: string;
  readonly path: string;
  dispose(): void;
}

/** A pap home with the agent's mirror folder (0700), as `vmGate` makes it. */
export function makeBed(): Bed {
  const root = mkdtempSync(join(tmpdir(), "pap-mirror-"));
  const folder = join(root, "agents", ".mirrors", AGENT);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return {
    root,
    folder,
    path: join(folder, FILE),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
