import type { ModelsOverview } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuthKind } from "./provider-sharing.ts";

type ProviderAuth = ModelsOverview["providers"][number]["auth"];

/**
 * A provider's auth kind from what the overview knows, which is the relay's rule (`checkAuth().type === "api_key"`) without
 * running a `!command`: a stored credential says its type; a `models.json` key (a literal or `$VAR`) and a set environment
 * key count as `api_key`; nothing configured is null.
 */
export function authKindOf(auth: ProviderAuth): AuthKind | null {
  if (auth.stored !== null) return auth.stored;
  if (auth.status === "known" && auth.configured) return "api_key";
  if (auth.env.some((entry) => entry.set && !/OAUTH/i.test(entry.name))) return "api_key";
  return null;
}

export interface ProviderKinds {
  /** Every provider the overview lists, by id. Empty when the overview cannot be read (nothing is shared then). */
  get(): Promise<ReadonlyMap<string, { readonly label: string; readonly kind: AuthKind | null }>>;
  /** After a write of Pi's files (`models.onChanged`): the next read asks again. */
  reset(): void;
}

const TTL_MS = 60_000;

/** The overview, cached: cleared by `models.onChanged`, and after a minute for a sign-in that raised no event. */
export function createProviderKinds(deps: {
  readonly overview: () => Promise<ModelsOverview>;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn">;
  /** Every provider the overview lists, as it is built: the default sharing row is written here, whoever asks (RT-16). */
  readonly onSeen?: (provider: string, kind: AuthKind | null) => void;
}): ProviderKinds {
  let held: { at: number; value: Promise<ReturnType<typeof build>> } | null = null;
  function build(overview: ModelsOverview) {
    for (const provider of overview.providers) {
      // A failed default row (a busy or full database) must not reject the overview: the gate reads it without awaiting.
      try {
        deps.onSeen?.(provider.id, authKindOf(provider.auth));
      } catch (error) {
        deps.logger.warn("provider_sharing_seed_failed", { provider: provider.id, err: error });
      }
    }
    return new Map(
      overview.providers.map((provider) => [
        provider.id,
        { label: provider.name, kind: authKindOf(provider.auth) },
      ]),
    );
  }
  return {
    get() {
      if (held !== null && deps.clock.now() - held.at < TTL_MS) return held.value;
      const value = deps.overview().then(build, (error: unknown) => {
        deps.logger.warn("provider_kinds_unread", { err: error });
        if (held?.value === value) held = null;
        return new Map<string, { label: string; kind: AuthKind | null }>();
      });
      held = { at: deps.clock.now(), value };
      return value;
    },
    reset() {
      held = null;
    },
  };
}
