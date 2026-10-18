import { randomBytes } from "node:crypto";
import {
  type Caller,
  type ConfigGetResult,
  type ConfigSaveParams,
  type ConfigSaveResult,
  type ExtensionProviders,
  HELPER_OPS,
  type EnabledOp,
  type LoginMethod,
  type ModelsDiscoverResult,
  type ModelsPricingResult,
  type ModelsTestResult,
  type ModelsUsageResult,
  type PROVIDER_AUDIT_REASONS,
  type AvailableModels,
  type ModelsOverview,
  PapError,
  pickPrices,
  type ThinkingLevel,
  type RefreshCatalogResult,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import { newId } from "../../kernel/ids.ts";
import { createPiWriteQueue, type PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { type AuditPort } from "../audit/index.ts";
import { requireStepUp } from "../auth/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { SettingsPort } from "../settings/index.ts";
import { createAvailableCache } from "./available.ts";
import { createExtensionProviders } from "./extensions.ts";
import { createLoginFlows } from "./login-flows.ts";
import { createLoginPublisher } from "./login-publisher.ts";
import { createPricingCache } from "./pricing-cache.ts";
import { createProviderConfig } from "./provider-config.ts";
import { createProviderUsage } from "./usage.ts";

/** Reading is quick; a write waits for Pi's settings lock; a catalog refresh is a round of network requests (M7R49). */
const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 30_000;
const REFRESH_DEADLINE_MS = 120_000;
/** A provider request is 15 s in the helper (M7R66); the helper starts, may run a key command, then asks. */
const PROVIDER_DEADLINE_MS = 60_000;
const PRICING_DEADLINE_MS = 45_000;
/** Loading the extensions is Pi's own offline load of them, as a session does. */
const EXTENSIONS_DEADLINE_MS = 60_000;
/** A selection edit that names an extension's model loads the extensions first (`enabled-models.ts`). */
const SET_ENABLED_DEADLINE_MS = EXTENSIONS_DEADLINE_MS;

export { WRITE_QUEUE_MAX } from "../../kernel/pi-write-queue.ts";

type OpName = keyof typeof HELPER_OPS;
export interface ModelsServiceDeps {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "onLastSubscriberLeft">;
  /** The owner's `models` setting: the models.dev lookup is off unless it says so (M7R138). */
  readonly settings: Pick<SettingsPort, "models">;
  /** The daemon's one Pi write queue; a service built alone (a test) gets a queue of its own. */
  readonly writes?: PiWriteQueue;
}

export function createModelsService(deps: ModelsServiceDeps) {
  const writes = deps.writes ?? createPiWriteQueue();
  /**
   * `models.available` answers (MP-RT-06): every write of Pi's files below, queued or not, clears it once the helper run
   * settles, whether it succeeded or failed. A helper killed mid-write (deadline, cancel) may still land its file
   * afterwards: that answer is then at most one TTL (10 s) old.
   */
  const availableCache = createAvailableCache();
  const extensionProviders = createExtensionProviders({
    ask: () => run("models.extensions", {}, EXTENSIONS_DEADLINE_MS, undefined),
  });
  /** A write of Pi's files settled: the available lists are read again, and an extension read joins no older run. */
  const wrote = (): void => {
    availableCache.clear();
    extensionProviders.invalidate();
  };
  const clearedAfter = async <T>(task: Promise<T>): Promise<T> => {
    try {
      return await task;
    } finally {
      wrote();
    }
  };
  /** The cwd the helper reads is a folder the caller has a project in (M7R50): an arbitrary path is no probe. */
  function checkedCwd(caller: Caller, cwd: string | undefined): string | undefined {
    if (cwd === undefined) return undefined;
    if (!deps.projects.covers(caller.userId, cwd)) throw new PapError("invalid_cwd");
    return cwd;
  }

  /** Every write of Pi's own files goes one after the other, through the queue the mcp module shares (MC28, MC29). */
  const serialised = <T>(task: () => Promise<T>): Promise<T> =>
    writes.run(async () => {
      try {
        return await task();
      } finally {
        wrote();
      }
    });

  /**
   * One helper run. Its result is parsed with the contract's strict schema before it goes anywhere: a field the
   * schema does not name (a key, say) fails the call, and nothing of the helper's text reaches the caller or the log.
   */
  async function run<N extends OpName>(
    op: N,
    params: unknown,
    deadlineMs: number,
    cwd: string | undefined,
    onEvent?: (event: unknown) => void,
  ): Promise<ReturnType<(typeof HELPER_OPS)[N]["result"]["parse"]>> {
    const handle = deps.helpers.run(op, params, {
      deadlineMs,
      ...(cwd === undefined ? {} : { cwd }),
      ...(onEvent === undefined ? {} : { onEvent }),
    });
    const parsed = HELPER_OPS[op].result.safeParse(await handle.done);
    if (!parsed.success) {
      deps.logger.warn("models_helper_result_invalid", { op, issues: parsed.error.issues.length });
      throw new PapError("helper_failed");
    }
    return parsed.data as never;
  }

  /**
   * What a models.json save tells the log: one of two fixed kinds and an error code, nothing else. The helper's own text
   * never goes to the log (R66).
   */
  const SAVE_EVENTS = new Set([
    "folder_sync_failed",
    "enabled_models_not_synced",
    "validation_copy_not_removed",
  ]);
  /** The revision of models.json is an HMAC under this key (MC32): new at each boot, so a restart answers one `conflict`. */
  const revisionKey = randomBytes(32).toString("hex");
  const logSaveEvent = (event: unknown): void => {
    const { kind, code } = (event ?? {}) as { kind?: unknown; code?: unknown };
    if (typeof kind !== "string" || !SAVE_EVENTS.has(kind)) return;
    deps.logger.warn("models_config_save_event", {
      kind,
      code: typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : "unknown",
    });
  };

  /** Sign-in, keys and sign-out (Task 11). Audit lines name the provider and the method, never a value (M7R60). */
  const audit = (
    caller: Caller,
    reason: (typeof PROVIDER_AUDIT_REASONS)[number],
    detail: Record<string, string>,
  ) => deps.audit.append({ ownerId: caller.userId, actor: "user", kind: "auth", reason, detail });
  const flows = createLoginFlows({
    helpers: deps.helpers,
    clock: deps.clock,
    logger: deps.logger,
    publisher: createLoginPublisher(deps.hub),
    newId,
    onSignedIn: ({ ownerId, provider, method }) => {
      wrote();
      deps.audit.append({
        ownerId,
        actor: "user",
        kind: "auth",
        reason: "provider_signed_in",
        detail: { provider, method },
      });
    },
  });

  // MC31: a reload or a closed tab leaves a flow unwatched; the 60 s rule applies again from that moment.
  deps.hub.onLastSubscriberLeft("login", (flowId) => flows.detach(flowId));

  /** The provider form's methods (Task 10): the same queue, run, key and audit as the config save. */
  const provider = createProviderConfig({
    run,
    serialised,
    revisionKey,
    clock: deps.clock,
    audit,
    invalidate: wrote,
    logSaveEvent,
  });

  const pricingCache = createPricingCache();
  const providerUsage = createProviderUsage({
    clock: deps.clock,
    ask: (providerId) => run("models.usage", { providerId }, PROVIDER_DEADLINE_MS, undefined),
  });

  return {
    providerForm: provider,
    async overview(caller: Caller, cwd?: string): Promise<ModelsOverview> {
      return run("models.overview", {}, READ_DEADLINE_MS, checkedCwd(caller, cwd));
    },
    /** Cached 10 s per cwd, one helper run for concurrent callers; the cwd is checked before the cache is asked. */
    async available(caller: Caller, cwd?: string): Promise<AvailableModels> {
      const checked = checkedCwd(caller, cwd);
      return availableCache.read(checked ?? "", deps.clock.now(), () =>
        run("models.available", {}, READ_DEADLINE_MS, checked),
      );
    },
    async setDefault(caller: Caller, params: { provider: string; modelId: string; cwd?: string }) {
      const { cwd, ...rest } = params;
      const checked = checkedCwd(caller, cwd);
      return serialised(() => run("models.setDefault", rest, WRITE_DEADLINE_MS, checked));
    },
    async setDefaultThinking(caller: Caller, params: { level: ThinkingLevel; cwd?: string }) {
      const { cwd, ...rest } = params;
      const checked = checkedCwd(caller, cwd);
      return serialised(() => run("models.setDefaultThinking", rest, WRITE_DEADLINE_MS, checked));
    },
    async setEnabled(caller: Caller, params: { op: EnabledOp; cwd?: string }) {
      const { cwd, ...rest } = params;
      const checked = checkedCwd(caller, cwd);
      return serialised(() => run("models.setEnabled", rest, SET_ENABLED_DEADLINE_MS, checked));
    },
    async refreshCatalog(): Promise<RefreshCatalogResult> {
      return clearedAfter(run("models.refreshCatalog", {}, REFRESH_DEADLINE_MS, undefined));
    },
    /** The masked text of `models.json`: a secret never leaves the helper (M7R62). */
    async configGet(): Promise<ConfigGetResult> {
      return run("models.config.get", { revisionKey }, READ_DEADLINE_MS, undefined);
    },
    /**
     * The password step-up first (owner c3): a saved provider entry can point Pi at any URL or run a command. A refusal
     * for invalid content comes back as a result with JSON paths and is not audited; a saved file is, with no value.
     */
    async configSave(caller: Caller, params: ConfigSaveParams): Promise<ConfigSaveResult> {
      requireStepUp(caller, deps.clock.now());
      const result = await serialised(() =>
        run("models.config.save", { ...params, revisionKey }, WRITE_DEADLINE_MS, undefined, logSaveEvent),
      );
      if ("revision" in result) audit(caller, "models_config_saved", {});
      return result;
    },
    /**
     * Asks the provider's `/models` with its key. The password step-up first (owner c3): the key goes to the base URL a
     * `models.json` names. A failed request is a status class in the answer, never the provider's text (M7R66).
     */
    async discover(caller: Caller, params: { provider: string }): Promise<ModelsDiscoverResult> {
      requireStepUp(caller, deps.clock.now());
      const result = await run("models.discover", params, PROVIDER_DEADLINE_MS, undefined);
      audit(caller, "provider_discovered", { provider: params.provider });
      return result;
    },
    /** One completion of at most 16 output tokens, on the owner's click. */
    async test(_caller: Caller, params: { provider: string; modelId: string }): Promise<ModelsTestResult> {
      return run("models.test", params, PROVIDER_DEADLINE_MS, undefined);
    },
    /**
     * The models.dev lookup is the owner's opt-in (M7R138): off, it answers `forbidden` before a helper starts or a
     * request is made, cached answers included. On, the extracted price map is kept for an hour (M7R67, MC34) and later
     * questions are answered from it.
     */
    async pricing(
      caller: Caller,
      params: { provider?: string; modelId: string },
    ): Promise<ModelsPricingResult> {
      if (!deps.settings.models(caller.userId).modelsDevPricing) throw new PapError("forbidden");
      const kept = pricingCache.get(deps.clock.now());
      if (kept !== undefined) return { entries: pickPrices(kept, params.provider, params.modelId) };
      const answer = await run("models.pricing", params, PRICING_DEADLINE_MS, undefined);
      if (answer.catalog !== undefined) pricingCache.set(answer.catalog, deps.clock.now());
      return { entries: answer.entries };
    },
    /** The provider's usage quotas on the owner's click; no step-up (an official endpoint, a read, M10R110). */
    async usage(_caller: Caller, params: { providerId: string }): Promise<ModelsUsageResult> {
      return providerUsage.get(params.providerId);
    },
    /** The providers the global extensions register: read-only, on the owner's click, no step-up (MPR17). */
    async extensions(): Promise<ExtensionProviders> {
      return extensionProviders.get();
    },
    /** Starts a sign-in flow. The password step-up comes first (owner c3): sign-in runs code and redirects traffic. */
    async login(caller: Caller, params: { provider: string; method: LoginMethod }) {
      requireStepUp(caller, deps.clock.now());
      return { flowId: flows.start(caller.userId, params.provider, params.method) };
    },
    async loginAnswer(caller: Caller, params: { flowId: string; promptId: string; value: string }) {
      flows.answer(caller.userId, params.flowId, params.promptId, params.value);
      return { ok: true as const };
    },
    async loginCancel(caller: Caller, params: { flowId: string }) {
      flows.cancel(caller.userId, params.flowId);
      return { ok: true as const };
    },
    /** Stops the caller's own live flow for a provider; no step-up, it only ends a flow (MC31). */
    async cancelLogin(caller: Caller, params: { provider: string }) {
      flows.cancelByProvider(caller.userId, params.provider);
      return { ok: true as const };
    },
    /** `open` registers the subscription (it may throw `capacity`); the flow counts as watched only once it did. */
    async subscribeLogin(caller: Caller, flowId: string, open: (flowId: string) => string) {
      flows.check(caller.userId, flowId);
      const sub = open(flowId);
      flows.attach(caller.userId, flowId);
      return { sub };
    },
    /** The password step-up first (owner c3). The key goes to the helper and nowhere else. */
    async setApiKey(caller: Caller, params: { provider: string; key: string }) {
      requireStepUp(caller, deps.clock.now());
      const result = await clearedAfter(run("auth.setApiKey", params, WRITE_DEADLINE_MS, undefined));
      audit(caller, "provider_key_set", { provider: params.provider });
      return result;
    },
    /** Removing a credential never asks for the password (M7R133). */
    async logout(caller: Caller, params: { provider: string }) {
      const result = await clearedAfter(run("auth.logout", params, WRITE_DEADLINE_MS, undefined));
      audit(caller, "provider_signed_out", { provider: params.provider });
      return result;
    },
  };
}
export type ModelsService = ReturnType<typeof createModelsService>;
