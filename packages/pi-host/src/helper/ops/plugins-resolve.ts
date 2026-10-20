import { HELPER_OPS, type PluginsResolveParams } from "@pap/contracts";
import type { z } from "zod";
import { pluginIdOf } from "../plugin-id.ts";
import { sourceOf, type PackageEntry } from "../plugin-entries.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { openSettings } from "./models-open.ts";

type Result = z.infer<(typeof HELPER_OPS)["plugins.resolve"]["result"]>;

/**
 * AVM-E33: the exact spelling `settings.json` holds for each id, for the daemon alone. The owner's Pi folder only: the
 * project scope is not an agent's to pick. An id nothing holds is `null`; the daemon decides what that means.
 */
export async function resolvePlugins(
  params: z.infer<typeof PluginsResolveParams>,
  ctx: Pick<HelperContext, "agentDir" | "home">,
): Promise<Result> {
  const settings = await openSettings({ agentDir: ctx.agentDir, home: ctx.home });
  if (settings.unreadable.length > 0)
    throw new HelperOpError("config_invalid", settings.unreadable.join(","));
  const held = new Map<string, string>();
  for (const entry of (settings.manager.getGlobalSettings().packages ?? []) as PackageEntry[])
    held.set(pluginIdOf("user", sourceOf(entry)), sourceOf(entry));
  return { sources: params.ids.map((id) => held.get(id) ?? null) };
}

export const pluginsResolveOp = defineOp({
  params: HELPER_OPS["plugins.resolve"].params,
  run: (params, ctx) => resolvePlugins(params, ctx),
});
