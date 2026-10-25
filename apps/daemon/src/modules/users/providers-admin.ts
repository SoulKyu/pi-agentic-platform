import { PapError, type HandlerTable, type ProviderSharingView } from "@pap/contracts";
import type { AuditPort } from "../audit/index.ts";
import type { ProviderKinds } from "./auth-kinds.ts";
import { isSharingExempt, type ProviderSharing } from "./provider-sharing.ts";

export interface ProvidersAdmin {
  /** Every provider with a sign-in, with its switch. The first sight of a provider writes its default row. */
  list(): Promise<ProviderSharingView[]>;
  /** `bad_request` for a subscription provider and the bridge (never shared), `not_found` for a provider nothing knows. */
  setShared(provider: string, shared: boolean): Promise<void>;
}

export function createProvidersAdmin(deps: {
  readonly sharing: ProviderSharing;
  readonly kinds: ProviderKinds;
  /** The relay pushes every box's policy again: a switch takes effect at once. */
  readonly refresh: () => void;
}): ProvidersAdmin {
  return {
    async list() {
      const known = await deps.kinds.get();
      const views: ProviderSharingView[] = [];
      for (const [provider, { label, kind }] of known) {
        if (isSharingExempt(provider) || kind === null) continue;
        views.push({
          provider,
          label,
          auth: kind,
          shared: kind !== "oauth" && deps.sharing.stateOf(provider, kind),
          servable: kind !== "oauth",
        });
      }
      return views.sort((a, b) => a.provider.localeCompare(b.provider)).slice(0, 500);
    },
    async setShared(provider, shared) {
      if (isSharingExempt(provider)) throw new PapError("bad_request");
      const known = (await deps.kinds.get()).get(provider);
      if (known === undefined && !deps.sharing.list().some((row) => row.provider === provider))
        throw new PapError("not_found");
      if (known?.kind === "oauth") throw new PapError("bad_request");
      deps.sharing.set(provider, shared);
      deps.refresh();
    },
  };
}

export type ProvidersRpc = Pick<HandlerTable, "users.providers" | "users.setProviderShared">;

export function providersRpc(admin: ProvidersAdmin, audit: Pick<AuditPort, "append">): ProvidersRpc {
  return {
    "users.providers": async () => ({ providers: await admin.list() }),
    "users.setProviderShared": async ({ provider, shared }, ctx) => {
      await admin.setShared(provider, shared);
      audit.append({
        ownerId: ctx.caller.userId,
        actor: "user",
        actorId: ctx.caller.userId,
        kind: "auth",
        reason: "provider_sharing_set",
        detail: { provider, shared },
      });
      return { ok: true as const };
    },
  };
}
