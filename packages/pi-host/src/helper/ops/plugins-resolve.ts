import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS, type PluginsResolveParams } from "@pap/contracts";
import type { z } from "zod";
import { identityOf, pluginIdKey, pluginIdOf, pluginIdsOf } from "../plugin-id.ts";
import { sourceOf, type PackageEntry } from "../plugin-entries.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { openSettings } from "./models-open.ts";

type Result = z.infer<(typeof HELPER_OPS)["plugins.resolve"]["result"]>;

/**
 * AVM-E33: the exact spelling `settings.json` holds for each id, for the daemon alone. The owner's Pi folder only: the
 * project scope is not an agent's to pick. An id is the one `plugins.list` gives (the package identity's, so a new version
 * or ref resolves to the new spelling) or, for a pick saved before those, its exact source's. An id nothing holds is `null`;
 * the daemon decides what that means.
 */
export async function resolvePlugins(
  params: z.infer<typeof PluginsResolveParams>,
  ctx: Pick<HelperContext, "agentDir" | "papHome" | "home">,
): Promise<Result> {
  const settings = await openSettings({ agentDir: ctx.agentDir, home: ctx.home });
  if (settings.unreadable.length > 0)
    throw new HelperOpError("config_invalid", settings.unreadable.join(","));
  const key = pluginIdKey(ctx.papHome);
  const sources = ((settings.manager.getGlobalSettings().packages ?? []) as PackageEntry[]).map(sourceOf);
  const pm = new DefaultPackageManager({
    cwd: ctx.agentDir,
    agentDir: ctx.agentDir,
    settingsManager: settings.manager,
  });
  const held = new Map<string, string>();
  const listed = pluginIdsOf(key, "user", sources, identityOf(pm));
  sources.forEach((source, index) => {
    for (const id of [listed[index] as string, pluginIdOf(key, "user", source)])
      if (!held.has(id)) held.set(id, source);
  });
  return { sources: params.ids.map((id) => held.get(id) ?? null) };
}

export const pluginsResolveOp = defineOp({
  params: HELPER_OPS["plugins.resolve"].params,
  run: (params, ctx) => resolvePlugins(params, ctx),
});
