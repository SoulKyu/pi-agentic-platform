import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { LICENCE_FILES } from "./build-archive-stage.ts";

/** Puts this checkout's licence texts into a fixture repository, as the builders require them. */
export const putLicences = (repo: string): void => {
  for (const file of LICENCE_FILES)
    cpSync(join(resolve(import.meta.dirname, ".."), file), join(repo, file), { recursive: true });
};
