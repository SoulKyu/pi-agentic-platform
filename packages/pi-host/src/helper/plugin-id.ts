import { createHash } from "node:crypto";

/** AVM-E33: the id a package is known by outside the helper: a hash of its scope and its exact source, never the source itself. */
export const pluginIdOf = (scope: "user" | "project", source: string): string =>
  createHash("sha256").update(`pap-plugin\0${scope}\0${source}`).digest("hex").slice(0, 32);
