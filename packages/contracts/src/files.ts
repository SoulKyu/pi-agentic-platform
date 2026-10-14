import { z } from "zod";
import { defineMethod } from "./define.ts";

export const FILE_LIMITS = {
  pathBytes: 4096,
  nameBytes: 255,
  listEntries: 5000,
  readChunkBytes: 256 * 1024,
  editableBytes: 384 * 1024,
  searchQuery: 128,
  searchResults: 50,
  uploadBytes: 25 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  attachmentsPerPrompt: 10,
  pendingPerOwner: 32,
  pendingBytesPerOwner: 200 * 1024 * 1024,
} as const;

/** An absolute path as a client sends it; the daemon's boundary decides the rest (M8R14). */
export const FilePath = z
  .string()
  .min(1)
  .max(FILE_LIMITS.pathBytes)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "an absolute path");
export const Etag = z.string().regex(/^[0-9a-f]{32}$/);

export const FileEntry = z.object({
  name: z
    .string()
    .min(1)
    .max(FILE_LIMITS.nameBytes * 2),
  kind: z.enum(["file", "dir", "link", "other"]),
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().nonnegative().nullable(),
  hidden: z.enum(["ignored", "excluded"]).nullable(),
  /** pap's data, Pi's credentials or transcripts: listed, never opened (§ The boundary at a glance). */
  protected: z.boolean(),
  link: z.enum(["inside", "outside", "broken"]).nullable(),
  linkDir: z.boolean(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileMeta = z.object({
  path: FilePath,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  etag: Etag.nullable(),
  binary: z.boolean(),
  /** Not binary, at most 384 KiB, and a save of it fits one frame (M8R26): the editor may open it. */
  editable: z.boolean(),
  /** What a save needs from a browser session (M8R16, M8R101): nothing, `confirmProtected`, or that and a step-up. */
  protection: z.enum(["none", "confirm", "step_up"]),
});
export type FileMeta = z.infer<typeof FileMeta>;

/** What `PUT /files/raw` answers (M8R34, MC38): `written: false` is a `skip` that found the file, else the placed file. */
export const UploadAnswer = z.discriminatedUnion("written", [
  z.object({ written: z.literal(false) }),
  z.object({ written: z.literal(true), meta: FileMeta }),
]);
export type UploadAnswer = z.infer<typeof UploadAnswer>;

export const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ImageMime = z.enum(IMAGE_MIMES);
export type ImageMime = z.infer<typeof ImageMime>;
/** What `POST /upload` answers (M8R37): the pending upload, its kind sniffed from the bytes (M8R38). */
export const AttachmentView = z.object({
  id: AttachmentId,
  name: z
    .string()
    .min(1)
    .max(FILE_LIMITS.nameBytes * 2),
  size: z.number().int().nonnegative().max(FILE_LIMITS.uploadBytes),
  kind: z.enum(["image", "file"]),
  mimeType: ImageMime.nullable(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;

const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const filesMethods = {
  "files.list": defineMethod({
    name: "files.list",
    permission: "files:read",
    idempotent: true,
    params: z.object({ path: FilePath, showIgnored: z.boolean().optional() }),
    result: z.object({ entries: z.array(FileEntry).max(FILE_LIMITS.listEntries), truncated: z.boolean() }),
    errors: ["not_found"],
  }),
  "files.read": defineMethod({
    name: "files.read",
    permission: "files:read",
    idempotent: true,
    params: z.object({ path: FilePath, offset: Offset.optional() }),
    result: z.object({
      meta: FileMeta,
      text: z.string().max(FILE_LIMITS.readChunkBytes),
      offset: Offset,
      nextOffset: Offset.nullable(),
    }),
    errors: ["not_found"],
  }),
  "files.search": defineMethod({
    name: "files.search",
    permission: "files:read",
    idempotent: true,
    params: z.object({
      root: FilePath,
      query: z.string().min(1).max(FILE_LIMITS.searchQuery),
      limit: z.number().int().min(1).max(FILE_LIMITS.searchResults).optional(),
    }),
    result: z.object({
      paths: z.array(z.string().min(1).max(FILE_LIMITS.pathBytes)).max(FILE_LIMITS.searchResults),
      truncated: z.boolean(),
    }),
    errors: ["not_found", "capacity"],
  }),
  "files.write": defineMethod({
    name: "files.write",
    permission: "files:operate",
    idempotent: false,
    params: z.object({
      path: FilePath,
      text: z.string().max(FILE_LIMITS.editableBytes),
      baseEtag: Etag.nullable(),
      confirmProtected: z.literal(true).optional(),
    }),
    result: z.object({ meta: FileMeta }),
    errors: ["not_found", "conflict", "protected_path", "step_up_required", "forbidden", "payload_too_large"],
  }),
} as const;
