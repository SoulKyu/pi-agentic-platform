import type { PushDeps } from "../index.ts";

/**
 * The one place a test builds `PushDeps` from only the parts the code under test reaches (the rest of the daemon's ports
 * is not built for a unit test). A part a test forgets fails at the line that uses it, with its name.
 */
export function pushDepsOf(parts: { readonly [K in keyof PushDeps]?: unknown }): PushDeps {
  return parts as unknown as PushDeps;
}
