import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  HELPER_OPS,
  PLUGIN_LIMITS,
  type PluginSetEnabledResult,
  type PluginsListResult,
  type PluginView,
} from "@pap/contracts";
import type { z } from "zod";
import { killDetachedDescendants } from "../../descendants.ts";
import { within } from "../../policy/target-path.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import {
  disabledEntry,
  findEntry,
  isRemote,
  maskSource,
  type PackageEntry,
  safeForPi,
  sourceOf,
  stateOf,
} from "../plugin-entries.ts";
import { pluginIdKey, pluginIdOf } from "../plugin-id.ts";
import { pluginSource } from "../plugin-source.ts";
import { withInstallEnv } from "./install-env.ts";
import { commit } from "./models-defaults.ts";
import { guardSettingsWrite, isTrusted, openSettings, type OpenSettings } from "./models-open.ts";
import { offline } from "./offline.ts";

type Ctx = Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal">;
type Op = keyof typeof HELPER_OPS;
type Params<N extends Op> = z.infer<(typeof HELPER_OPS)[N]["params"]>;
type Scope = "user" | "project";

/** Pi's package manager over the settings of the scope(s) a call may touch, and the folder it works in. */
interface Opened {
  readonly settings: OpenSettings;
  readonly pm: DefaultPackageManager;
  readonly folder: string;
  readonly agentDir: string;
  /** The trusted project's real path when the call writes the project scope; its settings file is guarded too. */
  readonly project: string | undefined;
}

/**
 * The project scope needs a folder, the "Save anyway?" confirmation (M7R133) and Pi's recorded trust (M7R116); the user
 * scope reads and writes the agent directory and never looks at a project, whatever folder the call carried.
 */
async function open(ctx: Ctx, scopes: ReadonlySet<Scope>, confirmed: boolean): Promise<Opened> {
  let project: string | null = null;
  if (scopes.has("project")) {
    if (ctx.cwd === undefined) throw new HelperOpError("bad_params", "cwd");
    if (!confirmed) throw new HelperOpError("protected_path");
    const real = await fs.realpath(ctx.cwd).catch(() => null);
    if (real === null) throw new HelperOpError("bad_params", "cwd");
    if (!isTrusted(ctx.agentDir, real)) throw new HelperOpError("project_untrusted");
    project = real;
  }
  const settings = await openSettings({
    agentDir: ctx.agentDir,
    home: ctx.home,
    ...(project === null ? {} : { cwd: project }),
  });
  // A file that could not be read is never written over.
  if (settings.unreadable.length > 0)
    throw new HelperOpError("config_invalid", settings.unreadable.join(","));
  const folder = project ?? ctx.agentDir;
  const pm = new DefaultPackageManager({
    cwd: folder,
    agentDir: ctx.agentDir,
    settingsManager: settings.manager,
  });
  return { settings, pm, folder, agentDir: ctx.agentDir, project: project ?? undefined };
}

const packagesOf = (manager: SettingsManager, scope: Scope): PackageEntry[] =>
  [
    ...((scope === "project" ? manager.getProjectSettings() : manager.getGlobalSettings()).packages ?? []),
  ] as PackageEntry[];

/** Where a local entry of this scope is relative to (Pi's own rule: the agent directory, or the project's `.pi`). */
const baseOf = (opened: Opened, scope: Scope): string =>
  scope === "project" ? join(opened.folder, ".pi") : opened.agentDir;

const matchIn = (opened: Opened, scope: Scope, requested: string): number =>
  findEntry(packagesOf(opened.settings.manager, scope), requested, (source) =>
    resolve(baseOf(opened, scope), source),
  );

const clip = (text: string, max: number): string => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, max);

/** Ends the wait when the daemon cancels the run, and takes with it what Pi started. The pool kills the group anyway. */
function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      killDetachedDescendants();
      reject(new HelperOpError("failed", "cancelled"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A Pi call that may install or fetch: with the stripped environment, cancellable, and its failure only a code (the text goes to the log, clipped). */
async function online<T>(ctx: Ctx, label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await withInstallEnv(ctx.home, () => abortable(ctx.signal, call()), ctx.agentDir);
  } catch (error) {
    if (error instanceof HelperOpError) throw error;
    throw new HelperOpError(
      "failed",
      `plugins ${label}: ${clip(error instanceof Error ? error.message : "error", 180)}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return fs.stat(path).then(
    () => true,
    () => false,
  );
}

/** A local source is judged on its real path (a link inside home may lead out of it), and never home itself (MC55). */
async function requireInsideHome(source: string, home: string): Promise<void> {
  const [real, realHome] = await Promise.all([fs.realpath(source), fs.realpath(home)]).catch(() => [
    null,
    null,
  ]);
  if (real === null || realHome === null || real === realHome || !within(realHome, real))
    throw new HelperOpError("bad_params", "source");
}

export async function installPlugin(params: Params<"plugins.install">, ctx: Ctx): Promise<{ ok: true }> {
  const source = pluginSource(params.source, ctx.home);
  if (source === null) throw new HelperOpError("bad_params", "source");
  const opened = await open(ctx, new Set([params.scope]), params.confirmProtected === true);
  if (isAbsolute(source)) {
    if (!(await exists(source))) throw new HelperOpError("not_found", "source");
    await requireInsideHome(source, ctx.home);
  }
  const local = params.scope === "project";
  await online(ctx, "install", () => opened.pm.install(source, { local }));
  await guardSettingsWrite(ctx, opened.project);
  opened.pm.addSourceToSettings(source, { local });
  return commit(opened.settings);
}

export async function removePlugin(params: Params<"plugins.remove">, ctx: Ctx): Promise<{ ok: true }> {
  const opened = await open(ctx, new Set([params.scope]), params.confirmProtected === true);
  const index = matchIn(opened, params.scope, params.source);
  const entry = packagesOf(opened.settings.manager, params.scope)[index];
  if (entry === undefined) throw new HelperOpError("not_found", "source");
  const stored = sourceOf(entry);
  // Pi matches a local source against the folder it works in, not against the scope's base: it gets the absolute path.
  const source = isRemote(stored) ? stored : resolve(baseOf(opened, params.scope), stored);
  const local = params.scope === "project";
  // A source that would not be accepted today is dropped from settings and never handed to npm or git.
  if (safeForPi(stored, ctx.home)) await online(ctx, "remove", () => opened.pm.remove(source, { local }));
  await guardSettingsWrite(ctx, opened.project);
  opened.pm.removeSourceFromSettings(source, { local });
  return commit(opened.settings);
}

type Row = PluginSetEnabledResult["results"][number];

/** Switches whole packages (M7R114): off writes the four empty lists on the entry, on writes the bare source back. */
export async function setPluginsEnabled(
  params: Params<"plugins.setEnabled">,
  ctx: Ctx,
): Promise<PluginSetEnabledResult> {
  const scopes = new Set<Scope>(params.items.map((item) => item.scope));
  const opened = await open(ctx, scopes, params.confirmProtected === true);
  const next = new Map<Scope, PackageEntry[]>();
  for (const scope of scopes) next.set(scope, packagesOf(opened.settings.manager, scope));
  const changed = new Set<Scope>();
  const results: Row[] = [];
  for (const { source, scope } of params.items) {
    const entries = next.get(scope) ?? [];
    const index = findEntry(entries, source, (stored) => resolve(baseOf(opened, scope), stored));
    const entry = entries[index];
    if (entry === undefined) {
      results.push({ source, scope, ok: false, code: "not_found" });
      continue;
    }
    const state = stateOf(entry);
    if (state.filtered) {
      results.push({ source, scope, ok: false, code: "filtered" });
      continue;
    }
    if (state.enabled !== params.enabled) {
      entries[index] = params.enabled ? sourceOf(entry) : disabledEntry(sourceOf(entry));
      changed.add(scope);
    }
    results.push({ source, scope, ok: true });
  }
  if (changed.size > 0) {
    await guardSettingsWrite(ctx, opened.project);
    if (changed.has("user")) opened.settings.manager.setPackages(next.get("user") as never);
    if (changed.has("project")) opened.settings.manager.setProjectPackages(next.get("project") as never);
    await commit(opened.settings);
  }
  return { results };
}

type SettingsView = ReturnType<SettingsManager["getGlobalSettings"]>;

/**
 * The settings manager as Pi's updater must see it: only this scope's packages, and only those a call may hand to npm or
 * git. Pi updates by package identity across both scopes, so a project call would otherwise reach the user's packages
 * (which take the step-up) and the other way round.
 */
function scopedView(manager: SettingsManager, scope: Scope, home: string): SettingsManager {
  const only = (settings: SettingsView, wanted: boolean): SettingsView => ({
    ...settings,
    packages: wanted
      ? (settings.packages ?? []).filter((entry) => safeForPi(sourceOf(entry as PackageEntry), home))
      : [],
  });
  return new Proxy(manager, {
    get(target, property) {
      if (property === "getGlobalSettings") return () => only(target.getGlobalSettings(), scope === "user");
      if (property === "getProjectSettings")
        return () => only(target.getProjectSettings(), scope === "project");
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * M7R117: the SDK has a read-only check (`checkForAvailableUpdates`, on the class and not on the `PackageManager`
 * interface): it names what has a newer version, then `update` applies it. The answer is what the check found, so the
 * web says "Update" and shows what changed. With no scope the owner's Pi folder is updated.
 */
export async function updatePlugins(
  params: Params<"plugins.update">,
  ctx: Ctx,
): Promise<z.infer<(typeof HELPER_OPS)["plugins.update"]["result"]>> {
  const scope = params.scope ?? "user";
  const opened = await open(ctx, new Set([scope]), params.confirmProtected === true);
  let target: string | undefined;
  if (params.source !== undefined) {
    const entry = packagesOf(opened.settings.manager, scope)[matchIn(opened, scope, params.source)];
    if (entry === undefined) throw new HelperOpError("not_found", "source");
    const stored = sourceOf(entry);
    if (!safeForPi(stored, ctx.home)) throw new HelperOpError("bad_params", "source");
    target = isRemote(stored) ? stored : resolve(baseOf(opened, scope), stored);
  }
  const pm = new DefaultPackageManager({
    cwd: opened.folder,
    agentDir: ctx.agentDir,
    settingsManager: scopedView(opened.settings.manager, scope, ctx.home),
  });
  const found = await online(ctx, "update check", () => pm.checkForAvailableUpdates());
  await online(ctx, "update", () => pm.update(target));
  const updated = found
    .filter((update) => update.scope === scope && (target === undefined || update.source === target))
    .slice(0, PLUGIN_LIMITS.list)
    .map((update) => ({ source: clip(maskSource(update.source), PLUGIN_LIMITS.source), scope }));
  return { updated };
}

/**
 * Every configured package with whether it is installed, switched on and hand-filtered. Offline (MC52): a package that
 * is not there is listed with no path and nothing is fetched. A project's packages only while Pi's trust store says `true`.
 */
export async function listPlugins(ctx: Ctx & Pick<HelperContext, "papHome">): Promise<PluginsListResult> {
  const idKey = pluginIdKey(ctx.papHome);
  let project: string | null = null;
  if (ctx.cwd !== undefined) {
    const real = await fs.realpath(ctx.cwd).catch(() => null);
    if (real === null) throw new HelperOpError("bad_params", "cwd");
    if (isTrusted(ctx.agentDir, real)) project = real;
  }
  const settings = await openSettings({
    agentDir: ctx.agentDir,
    home: ctx.home,
    ...(project === null ? {} : { cwd: project }),
  });
  const folder = project ?? ctx.agentDir;
  const pm = new DefaultPackageManager({
    cwd: folder,
    agentDir: ctx.agentDir,
    settingsManager: settings.manager,
  });
  const scopes: Scope[] = project === null ? ["user"] : ["user", "project"];
  return withInstallEnv(
    ctx.home,
    () =>
      offline(async () => {
        const plugins: PluginView[] = [];
        let truncated = false;
        for (const scope of scopes)
          for (const entry of packagesOf(settings.manager, scope)) {
            const source = clip(maskSource(sourceOf(entry)), PLUGIN_LIMITS.source + 1);
            if (
              source === "" ||
              source.length > PLUGIN_LIMITS.source ||
              plugins.length >= PLUGIN_LIMITS.list
            ) {
              truncated = true;
              continue;
            }
            let path: string | undefined;
            try {
              path = pm.getInstalledPath(sourceOf(entry), scope);
            } catch {
              path = undefined;
            }
            const installedPath =
              path !== undefined &&
              isAbsolute(path) &&
              path.length <= PLUGIN_LIMITS.path &&
              !path.includes("\0")
                ? path
                : null;
            plugins.push({
              id: pluginIdOf(idKey, scope, sourceOf(entry)),
              source,
              scope,
              installedPath,
              ...stateOf(entry),
            });
          }
        return { plugins, truncated };
      }),
    ctx.agentDir,
  );
}

export const pluginsListOp = defineOp({
  params: HELPER_OPS["plugins.list"].params,
  run: (_params, ctx) => listPlugins(ctx),
});
export const pluginsInstallOp = defineOp({
  params: HELPER_OPS["plugins.install"].params,
  run: (params, ctx) => installPlugin(params, ctx),
});
export const pluginsRemoveOp = defineOp({
  params: HELPER_OPS["plugins.remove"].params,
  run: (params, ctx) => removePlugin(params, ctx),
});
export const pluginsUpdateOp = defineOp({
  params: HELPER_OPS["plugins.update"].params,
  run: (params, ctx) => updatePlugins(params, ctx),
});
export const pluginsSetEnabledOp = defineOp({
  params: HELPER_OPS["plugins.setEnabled"].params,
  run: (params, ctx) => setPluginsEnabled(params, ctx),
});
