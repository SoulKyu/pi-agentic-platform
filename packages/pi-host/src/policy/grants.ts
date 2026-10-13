/** Session grants, and provisional always grants, kept per worker: the oldest is dropped past this (M2R74). */
export const MAX_SESSION_GRANTS = 1000;

export interface PolicyGrants {
  hasSession(key: string): boolean;
  rememberSession(key: string): void;
  /** The rules version now: read when a question is asked, and handed back to `rememberAlways` with its answer. */
  version(): number;
  /** An "always" answer the daemon has not pushed back yet: it lasts until the next policy update (M2-RT-01). */
  hasProvisionalAlways(key: string): boolean;
  /** `askedAt` is the version when the question was asked: an update that landed since then has already ended it. */
  rememberAlways(key: string, askedAt: number): void;
}

/** One per worker; insertion-ordered, so the oldest grant is the first dropped at the cap. */
export function createPolicyGrants(rulesVersion: () => number, max = MAX_SESSION_GRANTS): PolicyGrants {
  const session = new Set<string>();
  const provisional = new Map<string, number>();
  return {
    hasSession: (key) => session.has(key),
    rememberSession(key) {
      session.delete(key);
      session.add(key);
      if (session.size > max) session.delete(session.values().next().value as string);
    },
    version: rulesVersion,
    hasProvisionalAlways: (key) => provisional.get(key) === rulesVersion(),
    rememberAlways(key, askedAt) {
      provisional.delete(key);
      provisional.set(key, askedAt);
      if (provisional.size > max) provisional.delete(provisional.keys().next().value as string);
    },
  };
}
