import { type BoxRef, boxKey, type RelayCommand } from "@pap/contracts";

type BoxPolicy = Omit<Extract<RelayCommand, { type: "box_policy" }>, "type">;
export type PolicyVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: "model" | "paused" | "budget" };
export interface PolicyQuery {
  /** The provider of a `llm.internal` route; null for the bridge. */
  readonly provider: string | null;
  readonly model: string | null;
}
export type RelayPolicy = ReturnType<typeof createRelayPolicy>;

/** Until T0b records the bridge's exact model ids, any `claude-` id is the bridge's (R13). */
const CLAUDE_MODEL = /^claude-[a-z0-9.-]{1,64}$/;
const MAX_BOXES = 4096;

interface Entry {
  readonly pairs: ReadonlyMap<string, ReadonlySet<string>>;
  readonly claude: boolean;
  readonly claudeToken: string | null;
  readonly blocked: BoxPolicy["blocked"];
}

/**
 * R13: what each box may ask (the pairs its picker offers, and the bridge), and whether it may ask now. The daemon pushes
 * a policy at every launch and at every pause or budget change. A box nobody told about may use nothing (fail closed).
 * Maps, never objects; at most 4096 boxes are kept, the oldest pushed first to go.
 */
export function createRelayPolicy() {
  const boxes = new Map<string, Entry>();
  return {
    set(policy: BoxPolicy): void {
      const pairs = new Map<string, Set<string>>();
      for (const { provider, id } of policy.models) {
        const models = pairs.get(provider) ?? new Set<string>();
        models.add(id);
        pairs.set(provider, models);
      }
      const key = boxKey(policy.box);
      boxes.delete(key);
      boxes.set(key, {
        pairs,
        claude: policy.claude,
        claudeToken: policy.claudeToken,
        blocked: policy.blocked,
      });
      if (boxes.size > MAX_BOXES) {
        const oldest = boxes.keys().next().value;
        if (oldest !== undefined) boxes.delete(oldest);
      }
    },
    /** The Claude token of the box's owner, as the daemon's last policy for the box carried it; null for a box nobody told about. */
    claudeTokenOf(box: BoxRef): string | null {
      return boxes.get(boxKey(box))?.claudeToken ?? null;
    },
    check(box: BoxRef, query: PolicyQuery): PolicyVerdict {
      const entry = boxes.get(boxKey(box));
      if (entry === undefined || query.model === null) return { ok: false, reason: "model" };
      const allowed =
        query.provider === null
          ? entry.claude && CLAUDE_MODEL.test(query.model)
          : entry.pairs.get(query.provider)?.has(query.model) === true;
      if (!allowed) return { ok: false, reason: "model" };
      return entry.blocked === null ? { ok: true } : { ok: false, reason: entry.blocked };
    },
  };
}
