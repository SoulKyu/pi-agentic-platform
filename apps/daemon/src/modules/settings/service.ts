import {
  AgentsSettings,
  AutomationSettings,
  MAX_SETTING_BYTES,
  ModelsSettings,
  NotificationsSettings,
  PapError,
  type Caller,
  type SettingKey,
  type SettingWrite,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SettingsStore } from "./store.ts";

/** What other modules read of the owner's settings. */
export interface SettingsPort {
  /** The owner's Models settings; a missing or damaged row reads as the defaults, so the lookup is off (M7R138). */
  models(ownerId: string): ModelsSettings;
  /** The owner's Automation settings; a missing or damaged row reads as the defaults, logged (M10R162). */
  automation(ownerId: string): AutomationSettings;
  /** The owner's Agents settings; a missing or damaged row reads as the defaults, subagents on (owner m12). */
  agents(ownerId: string): AgentsSettings;
  /** The owner's Notifications settings; a missing or damaged row reads as the defaults, logged (M12R18). */
  notifications(ownerId: string): NotificationsSettings;
}

export interface SettingsService extends SettingsPort {
  get(caller: Caller, key: SettingKey): { value: unknown; revision: number };
  set(caller: Caller, write: SettingWrite): { revision: number };
}

/** What the budget cap reads of the users (M14 RT-06). Required: a wiring that forgot it would leave members uncapped. */
export interface SettingsMembers {
  /** A member's daily cap in USD (`users.budget_usd`); null for the owner, who has none. */
  capOf(userId: string): number | null;
  ownerId(): string | null;
  /** A disabled account's automation is paused, whatever its stored setting says (M14 RT-03, the first chokepoint). */
  disabled(userId: string): boolean;
}

export function createSettingsService(deps: {
  readonly store: SettingsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly members: SettingsMembers;
}): SettingsService {
  function read(ownerId: string, key: SettingKey): { value: unknown; revision: number } {
    const row = deps.store.get(ownerId, key);
    if (!row) return { value: null, revision: 0 };
    try {
      return { value: JSON.parse(row.value) as unknown, revision: row.revision };
    } catch {
      // A damaged row reads as no setting: the client falls back to its defaults and the next write replaces it.
      deps.logger.warn("settings_row_unreadable", { key });
      return { value: null, revision: row.revision };
    }
  }
  const stored = (userId: string): AutomationSettings => {
    const parsed = AutomationSettings.safeParse(read(userId, "automation").value ?? {});
    if (parsed.success) return parsed.data;
    deps.logger.warn("settings_row_unreadable", { key: "automation" });
    return AutomationSettings.parse({});
  };
  /**
   * What every gate reads. A member's budget is `min(stored, cap)`, a stored `null` ("no budget") being the cap (RT-06a).
   * The time zone stays the member's own (quiet hours, triggers, the editor): only the budget DAY is the owner's, and the
   * runs registry decides that (R10).
   */
  const effective = (userId: string): AutomationSettings => {
    const own = deps.members.disabled(userId) ? { ...stored(userId), paused: true } : stored(userId);
    const cap = deps.members.capOf(userId);
    if (cap === null) return own;
    return { ...own, dailyBudgetUsd: Math.min(own.dailyBudgetUsd ?? cap, cap), dailyBudgetCapUsd: cap };
  };
  return {
    get(caller, key) {
      const row = read(caller.userId, key);
      // The editor shows the budget that applies and the cap line (RT-06c).
      return key === "automation" && deps.members.capOf(caller.userId) !== null
        ? { value: effective(caller.userId), revision: row.revision }
        : row;
    },
    models(ownerId) {
      const parsed = ModelsSettings.safeParse(read(ownerId, "models").value ?? {});
      if (parsed.success) return parsed.data;
      deps.logger.warn("settings_row_unreadable", { key: "models" });
      return ModelsSettings.parse({});
    },
    automation: (ownerId) => effective(ownerId),
    agents(ownerId) {
      const parsed = AgentsSettings.safeParse(read(ownerId, "agents").value ?? {});
      if (parsed.success) return parsed.data;
      deps.logger.warn("settings_row_unreadable", { key: "agents" });
      return AgentsSettings.parse({});
    },
    notifications(ownerId) {
      const parsed = NotificationsSettings.safeParse(read(ownerId, "notifications").value ?? {});
      if (parsed.success) return parsed.data;
      deps.logger.warn("settings_row_unreadable", { key: "notifications" });
      return NotificationsSettings.parse({});
    },
    set(caller, input) {
      let write = input;
      // A token cannot lift the budget, unpause or add slots: the automation setting is the browser's (M10R162, RT-04).
      // The agents setting is the browser's too: it sets what a new agent starts with (M11R99).
      // The notifications setting is the browser's too: a token could mute every push or turn names on (M12R10).
      if (
        (write.key === "automation" || write.key === "agents" || write.key === "notifications") &&
        caller.kind === "token"
      ) {
        throw new PapError("forbidden");
      }
      if (write.key === "automation") {
        const cap = deps.members.capOf(caller.userId);
        // A member's `null` is no budget, which the cap forbids (RT-06a); the owner's cap line is read only, never stored.
        if (cap !== null && (write.value.dailyBudgetUsd === null || write.value.dailyBudgetUsd > cap))
          throw new PapError("budget_cap");
        write = { ...write, value: { ...write.value, dailyBudgetCapUsd: null } };
      }
      const text = JSON.stringify(write.value);
      if (Buffer.byteLength(text, "utf8") > MAX_SETTING_BYTES) throw new PapError("payload_too_large");
      // Compare-and-set (owner R3-4): a write based on a revision that moved never lands over the newer copy.
      const revision = deps.store.put(caller.userId, write.key, text, write.baseRevision, deps.clock.now());
      if (revision === null) throw new PapError("conflict");
      return { revision };
    },
  };
}
