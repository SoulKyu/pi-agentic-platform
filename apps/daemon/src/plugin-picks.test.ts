import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HelperPool } from "./kernel/helper/pool.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createPluginPicks } from "./plugin-picks.ts";

/*
 * Mutants (RT-43), run for real:
 * - `check` lets a `null` source through -> "refuses an unknown id" fails (an unknown id would be saved).
 * - `sourcesOf` keeps the null -> "drops an id nothing holds" fails (the guest would be sent a null).
 * - `sourcesOf` asks the helper for no ids when the picks are null -> "null means every package" still passes;
 *   `sourcesOf` asks anyway -> "makes no helper call for no picks" fails.
 */
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function bed(answer: unknown) {
  const run = vi.fn(() => ({ done: Promise.resolve(answer), answer: () => false, cancel: () => {} }));
  const warn = vi.fn();
  const picks = createPluginPicks({
    helpers: { run } as unknown as Pick<HelperPool, "run">,
    logger: { ...silentLogger, warn },
  });
  return { picks, run, warn };
}

describe("plugin picks (AVM-E33)", () => {
  it("resolves ids to the exact sources, in order, through the helper", async () => {
    const { picks, run } = bed({ sources: ["npm:a@1", "git:h/x/y@v1"] });
    expect(await picks.sourcesOf([ID_A, ID_B])).toEqual(["npm:a@1", "git:h/x/y@v1"]);
    expect(run).toHaveBeenCalledWith("plugins.resolve", { ids: [ID_A, ID_B] }, expect.any(Object));
  });

  it("null means every package and makes no helper call; an empty list makes none either", async () => {
    const { picks, run } = bed({ sources: [] });
    expect(await picks.sourcesOf(null)).toBeNull();
    expect(await picks.sourcesOf([])).toEqual([]);
    await picks.check([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops an id nothing holds at launch, and says so without naming the source", async () => {
    const { picks, warn } = bed({ sources: ["npm:a@1", null] });
    expect(await picks.sourcesOf([ID_A, ID_B])).toEqual(["npm:a@1"]);
    expect(warn).toHaveBeenCalledWith("agent_plugin_pick_gone", { count: 1 });
  });

  it("refuses an unknown id at save with a typed error", async () => {
    const { picks } = bed({ sources: ["npm:a@1", null] });
    await expect(picks.check([ID_A, ID_B])).rejects.toEqual(new PapError("not_found"));
  });

  it("accepts ids the helper holds", async () => {
    const { picks } = bed({ sources: ["npm:a@1"] });
    await expect(picks.check([ID_A])).resolves.toBeUndefined();
  });

  it("an answer that breaks the contract is helper_failed, and nothing of it is trusted", async () => {
    const { picks } = bed({ sources: [42] });
    await expect(picks.sourcesOf([ID_A])).rejects.toEqual(new PapError("helper_failed"));
  });
});
