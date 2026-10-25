import { z } from "zod";

export const CLIENT_PATH_MAX = 4096;
/** The description `ClientPath` carries: a schema walk recognises a client path by it, wrapped or not. */
export const CLIENT_PATH_MARKER = "ClientPath";

let active: string[] | null = null;

/**
 * Runs a synchronous parse and returns the `ClientPath` values it accepted. zod's brand is type-only, so this is how
 * the dispatcher learns every path a request carries without a per-method list: a new path field is gated by using
 * `ClientPath` (M14). Outside a call nothing is recorded.
 */
export function collectClientPaths<T>(parse: () => T): { value: T; paths: string[] } {
  const outer = active;
  const paths: string[] = [];
  active = paths;
  try {
    return { value: parse(), paths };
  } finally {
    active = outer;
  }
}

/**
 * An absolute path as a client sends it; the daemon's boundary decides the rest (M8R14).
 * Not branded (deviation from the S1 brief): the same schema describes results the daemon builds from plain strings,
 * and a brand would force a cast at each producer. The gate rests on the collector, not on the type.
 */
export const ClientPath = z
  .string()
  .min(1)
  .max(CLIENT_PATH_MAX)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "an absolute path")
  .transform((path) => {
    active?.push(path);
    return path;
  })
  .describe(CLIENT_PATH_MARKER);
