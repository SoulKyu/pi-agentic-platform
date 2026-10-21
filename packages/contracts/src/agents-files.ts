import { z } from "zod";

/** The files the owner imports into a VM agent's home (sub-project 2, spec 7): a file at most 1 MiB, 32 files per agent. */
export const AGENT_FILE_LIMITS = { maxBytes: 1_048_576, maxFiles: 32 } as const;

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SEGMENTS = 8;
const MAX_PATH_CHARS = 512;

/**
 * A path relative to `/agent/home`: 1 to 8 segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`, no leading
 * `/`, no empty segment, at most 512 characters. Nothing else can be written, so no path leaves the home.
 */
export const AgentFilePath = z
  .string()
  .max(MAX_PATH_CHARS)
  .refine((path) => {
    const segments = path.split("/");
    return (
      segments.length <= MAX_SEGMENTS &&
      segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
    );
  }, "a relative path under the agent's home");
export type AgentFilePath = z.infer<typeof AgentFilePath>;

/** What the Files tab lists: the path, the size and the import date, never the content. */
export const AgentFileView = z
  .object({ path: AgentFilePath, size: z.number().int().min(0), importedAt: z.number().int().min(0) })
  .strict();
export type AgentFileView = z.infer<typeof AgentFileView>;
