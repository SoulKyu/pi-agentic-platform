import { join } from "node:path";
import { createAgentSessionServices, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type HelperContext, HelperOpError } from "../ops.ts";
import { createAuthFileStore, helperErrorOf } from "./auth-store.ts";
import { guardFile } from "./models-open.ts";
import { offline } from "./offline.ts";

export interface ExtensionLoad {
  readonly runtime: ModelRuntime;
  /** The global settings the load used (no project scope): the selection the no-session rule reads. */
  readonly settings: SettingsManager;
  /** The provider ids an enabled extension registered or replaced. */
  readonly touched: ReadonlySet<string>;
  /** True when an enabled extension failed to load or to register. */
  readonly extensionsFailed: boolean;
}

/**
 * The one loader of the owner's global extensions for a read (`models.usage`, `models.extensions`). Pi's runtime over
 * the Pi file boundary's credential store (the one `auth.*` uses): when Pi refreshes an expired OAuth
 * credential while resolving it, the new token is written by that store's `modify`, once, atomically, under Pi's own
 * lock folder, so neither a second writer nor a race with Pi's refresh exists. Nothing is refreshed from the network
 * here (`refreshOnCreate: false`, no model network).
 *
 * The enabled global extensions are loaded the way a session loads them (Pi's `createAgentSessionServices`, no project:
 * nothing is trusted), because an extension can repoint a provider; the base URL checked afterwards is then the one a
 * session would use. The providers an extension touched are recorded; a load or registration error is reported.
 * Project scope is off twice, and each gate holds alone: the settings manager starts untrusted, and Pi's reload
 * replaces that initial state with what `resolveProjectTrust` answers (`false`). Nothing here reads a project folder.
 */
export async function openExtensionLoad(ctx: HelperContext): Promise<ExtensionLoad> {
  const modelsPath = join(ctx.agentDir, "models.json");
  await guardFile(modelsPath, [ctx.agentDir, ctx.home]);
  await guardFile(join(ctx.agentDir, "settings.json"), [ctx.agentDir, ctx.home]);
  const runtime = await ModelRuntime.create({
    credentials: createAuthFileStore(ctx),
    modelsPath,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const touched = new Set<string>();
  const { registerProvider, registerNativeProvider, registerVirtualModel } = runtime;
  runtime.registerProvider = (id, config) => (touched.add(id), registerProvider.call(runtime, id, config));
  runtime.registerNativeProvider = (provider) => (
    touched.add(provider.id),
    registerNativeProvider.call(runtime, provider)
  );
  runtime.registerVirtualModel = (definition) => (
    touched.add(definition.provider),
    registerVirtualModel.call(runtime, definition)
  );
  const settingsManager = SettingsManager.create(ctx.agentDir, ctx.agentDir, { projectTrusted: false });
  const services = await createAgentSessionServices({
    cwd: ctx.agentDir,
    agentDir: ctx.agentDir,
    settingsManager,
    modelRuntime: runtime,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
  });
  const extensionsFailed =
    services.diagnostics.some((entry) => entry.type === "error") ||
    services.resourceLoader.getExtensions().errors.length > 0;
  return { runtime, settings: settingsManager, touched, extensionsFailed };
}

/** Pi's configuration is loaded with Pi's offline switch on (MC52): a missing package is a fixed failure, never an install. */
export async function loadRuntime<T>(
  open: (ctx: HelperContext) => Promise<T>,
  ctx: HelperContext,
): Promise<T> {
  try {
    return await offline(() => open(ctx));
  } catch (error) {
    throw helperErrorOf(error) ?? new HelperOpError("failed", "pi configuration could not be loaded");
  }
}
