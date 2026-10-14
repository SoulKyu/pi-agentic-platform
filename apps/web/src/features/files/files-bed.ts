import type { FileEntry, FileMeta } from "@pap/contracts";
import { vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

export const entry = (name: string, patch: Partial<FileEntry> = {}): FileEntry => ({
  name,
  kind: "file",
  size: 1,
  mtimeMs: 1,
  hidden: null,
  protected: false,
  link: null,
  linkDir: false,
  ...patch,
});
export const dirEntry = (name: string, patch: Partial<FileEntry> = {}) =>
  entry(name, { kind: "dir", ...patch });

export const meta = (path: string, patch: Partial<FileMeta> = {}): FileMeta => ({
  path,
  size: 10,
  mtimeMs: 100,
  etag: "a".repeat(32),
  binary: false,
  editable: true,
  protection: "none",
  ...patch,
});

/** A fake runtime whose `files.list` answers from `tree` (folder path to entries). */
export function filesBed(tree: Record<string, readonly FileEntry[]>) {
  const bed = fakeRuntime("open");
  bed.handlers["files.list"] = vi.fn((params) => {
    const entries = tree[(params as { path: string }).path];
    if (!entries) throw new RpcError("not_found");
    return { entries, truncated: false };
  });
  return bed;
}
