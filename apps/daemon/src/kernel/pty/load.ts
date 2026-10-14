import { createRequire } from "node:module";
import type { Logger } from "../logger.ts";

export type NodePty = typeof import("node-pty");

const require = createRequire(import.meta.url);

/**
 * node-pty is a native addon built at install time. A missing build must not take files and sessions down: the load
 * is tried once, a failure is logged once (no error text, it may hold paths) and the terminal answers
 * `terminal_unavailable` from then on (M8R51).
 */
export function createNodePtyLoader(attempt: () => NodePty): (log: Logger) => NodePty | null {
  let settled = false;
  let loaded: NodePty | null = null;
  return (log) => {
    if (settled) return loaded;
    settled = true;
    try {
      loaded = attempt();
    } catch {
      log.warn("terminal_unavailable", { reason: "node_pty_load_failed" });
    }
    return loaded;
  };
}

export const loadNodePty = createNodePtyLoader(() => require("node-pty") as NodePty);
