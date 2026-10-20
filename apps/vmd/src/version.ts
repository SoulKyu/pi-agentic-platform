import { readFileSync } from "node:fs";

/** The `version` of a package.json; a file without one is a broken install. */
export const readVersion = (path: string | URL): string => {
  const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error(`${String(path)} has no version`);
  return version;
};

/** The release bumps `apps/vmd/package.json` with the daemon's (release-please-config.json); `src/` and `dist/` both sit beside it. */
export const VMD_VERSION: string = readVersion(new URL("../package.json", import.meta.url));
