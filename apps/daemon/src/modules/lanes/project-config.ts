import { createHash } from "node:crypto";

export {
  type ConfigRead,
  isCleanRelative,
  PROJECT_CONFIG_LIMITS,
  PROJECT_CONFIG_PATH,
  readProjectConfig,
} from "@pap/contracts";
export const scriptHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
