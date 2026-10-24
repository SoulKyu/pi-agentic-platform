import { constants, closeSync } from "node:fs";
import { PROJECT_CONFIG_LIMITS, PROJECT_CONFIG_PATH, readProjectConfig } from "@pap/contracts";
import { openAt } from "../../nofollow.ts";
import { readAt } from "./fs-read.ts";
import { OpError, type OpEnv, withParent } from "./paths.ts";

type ProjectConfigAnswer = {
  packages: string[] | null;
  error: "too_large" | "invalid_yaml" | "not_a_map" | "bad_packages" | null;
};

/** `project.config`: the box's wants from `.pi/project.yaml`: its system `packages`, or why the file is not read. A missing file wants nothing. */
export function projectConfig(env: OpEnv): ProjectConfigAnswer {
  let bytes: Buffer;
  try {
    bytes = withParent(env, `${env.project}/${PROJECT_CONFIG_PATH}`, (parent, name) => {
      const fd = openAt(parent, name, constants.O_RDONLY);
      try {
        return readAt(fd, 0, PROJECT_CONFIG_LIMITS.fileBytes + 1);
      } finally {
        closeSync(fd);
      }
    });
  } catch (error) {
    // No file (or a link, a folder, a pipe in its place): nothing is wanted.
    if (error instanceof OpError && error.code === "not_found") return { packages: null, error: null };
    throw error;
  }
  const read = readProjectConfig(bytes);
  if (!read.ok) return { packages: null, error: read.error };
  if (read.badPackages === true) return { packages: null, error: "bad_packages" };
  return { packages: read.packages === undefined ? null : [...read.packages], error: null };
}
