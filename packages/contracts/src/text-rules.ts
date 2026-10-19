import { z } from "zod";

/** A control, format, line or paragraph separator character: text that is not one visible line. */
export const LINE_HIDDEN = /\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/u;

// pap targets Linux, so an absolute path starts with "/". A relative path would be resolved against the
// worker's own working directory, and the policy would then protect the wrong place.
export const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");
