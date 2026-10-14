import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../kernel/logger.ts";

/**
 * Removes the validation copies of models.json (they hold real secrets) a helper killed mid-save may have left under
 * `$PAP_HOME/models-check`. Run at boot, before any helper exists. A failure is logged, without a path.
 */
export async function sweepValidationCopies(papHome: string, logger: Logger): Promise<void> {
  try {
    await fs.rm(join(papHome, "models-check"), { recursive: true, force: true });
  } catch {
    logger.warn("models_check_sweep_failed", {});
  }
}
