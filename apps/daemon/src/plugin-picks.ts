import { HELPER_OPS, PapError } from "@pap/contracts";
import type { HelperPool } from "./kernel/helper/pool.ts";
import type { Logger } from "./kernel/logger.ts";

/** Reading `settings.json` once: the helper starts, does it and answers. */
const DEADLINE_MS = 30_000;

export interface PluginPicks {
  /**
   * The exact spellings of the picked packages (the guest narrows the image's list with them), from the ids the agent form
   * sent. `null` (every package) stays `null`. An id nothing holds any more is dropped and counted in the log: the agent
   * still starts, without that package.
   */
  sourcesOf(ids: readonly string[] | null): Promise<string[] | null>;
  /** At save: every id must be one the owner's Pi packages hold, else `not_found`. */
  check(ids: readonly string[]): Promise<void>;
}

/**
 * AVM-E33: the daemon resolves a package's id to its exact source from the owner's Pi packages, in the helper. The source,
 * which may hold a credential, never reaches a browser; the browser only ever holds the id.
 */
export function createPluginPicks(deps: {
  readonly helpers: Pick<HelperPool, "run">;
  readonly logger: Pick<Logger, "warn">;
}): PluginPicks {
  async function resolve(ids: readonly string[]): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    const handle = deps.helpers.run("plugins.resolve", { ids }, { deadlineMs: DEADLINE_MS });
    const parsed = HELPER_OPS["plugins.resolve"].result.safeParse(await handle.done);
    if (!parsed.success) {
      deps.logger.warn("plugin_picks_result_invalid", { issues: parsed.error.issues.length });
      throw new PapError("helper_failed");
    }
    return parsed.data.sources;
  }
  return {
    async sourcesOf(ids) {
      if (ids === null) return null;
      const sources = await resolve(ids);
      const held = sources.filter((source): source is string => source !== null);
      if (held.length < sources.length)
        deps.logger.warn("agent_plugin_pick_gone", { count: sources.length - held.length });
      return held;
    },
    async check(ids) {
      if ((await resolve(ids)).includes(null)) throw new PapError("not_found");
    },
  };
}
