import type { AvailableModels, AvailableModelsData, Caller, Role } from "@pap/contracts";
import type { ProviderKinds } from "./auth-kinds.ts";
import type { ProviderSharing } from "./provider-sharing.ts";

/** What members may see and use of the owner's providers. The owner sees everything; an unknown id sees nothing. */
export interface ProviderGate {
  /** Keeps the items whose provider `userId` may use. The overview is read only for a member. */
  filter<T extends { readonly provider: string }>(userId: string, items: readonly T[]): Promise<T[]>;
  /** `sessions.models`: a session's own list, without the providers the member may not use. */
  sessionModels(userId: string, data: AvailableModelsData): Promise<AvailableModelsData>;
  /** `sessions.availableModels`: the picker before a session exists. No cwd, so no project's folder is read for a member. */
  available(caller: Caller): Promise<AvailableModels>;
  /** After a write of Pi's files, or a sharing change: the overview is read again. */
  reset(): void;
}

export function createProviderGate(deps: {
  readonly roleOf: (userId: string) => Role | null;
  readonly sharing: ProviderSharing;
  readonly kinds: ProviderKinds;
  readonly models: () => { available(caller: Caller): Promise<AvailableModels> };
}): ProviderGate {
  async function allowed(userId: string): Promise<(provider: string) => boolean> {
    const role = deps.roleOf(userId);
    if (role === "owner") return () => true;
    if (role === null) return () => false;
    const kinds = await deps.kinds.get();
    return (provider) => deps.sharing.sharedFor(userId, provider, kinds.get(provider)?.kind ?? null);
  }
  const gate: ProviderGate = {
    async filter(userId, items) {
      const ok = await allowed(userId);
      return items.filter((item) => ok(item.provider));
    },
    async sessionModels(userId, data) {
      const ok = await allowed(userId);
      if (deps.roleOf(userId) === "owner") return data;
      return {
        ...data,
        models: data.models.filter((model) => ok(model.provider)),
        current: data.current === null || ok(data.current.provider) ? data.current : null,
      };
    },
    async available(caller) {
      // The cache of the helper's list is keyed by folder, not by user: the filter comes after it, per user.
      const data = await deps.models().available(caller);
      if (deps.roleOf(caller.userId) === "owner") return data;
      const ok = await allowed(caller.userId);
      return {
        ...data,
        models: data.models.filter((model) => ok(model.provider)),
        providers: data.providers.filter((provider) => ok(provider.id)),
        ...(data.providerIds === undefined ? {} : { providerIds: data.providerIds.filter(ok) }),
      };
    },
    reset() {
      deps.kinds.reset();
      // Read again now, not at the next member's request: a provider first seen on a subscription gets its row before it changes.
      deps.kinds.get().catch(() => undefined);
    },
  };
  return gate;
}
