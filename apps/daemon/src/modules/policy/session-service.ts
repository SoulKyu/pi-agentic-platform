import {
  type ApprovalMode,
  type Caller,
  DEFAULT_POLICY_SETTINGS,
  PapError,
  PolicySettings,
  type TaintState,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { SessionPolicyStore } from "./session-store.ts";
import type { SettingsPolicyStore } from "./settings-store.ts";

/**
 * What a worker gets when the stored settings no longer parse (M5R54): supervised asks, and an empty host list blocks
 * every URL. The owner can still work, and Settings › Approvals saves over the damaged document.
 */
export const RESTRICTIVE_SETTINGS: PolicySettings = {
  defaultMode: "supervised",
  builtinDenylist: true,
  denylist: [],
  allowHosts: [],
};

/** The part of the policy port that concerns a session's mode and taint and the owner's settings (Task 12a). */
export interface SessionPolicyPort {
  /** The mode in force (the session's own, else the owner's default), whether the session chose it, and its taint. */
  sessionPolicy(
    ownerId: string,
    sessionId: string,
  ): { mode: ApprovalMode; explicit: boolean; taint: TaintState };
  /** The settings a worker is given: the defaults when nothing is stored, `RESTRICTIVE_SETTINGS` when the document is unreadable. */
  settings(ownerId: string): PolicySettings;
  /** Raises the session's taint. True when it was not up yet. `not_found` for a session the owner does not have. */
  markTainted(ownerId: string, sessionId: string): boolean;
  /** The target takes the source's mode and taint with epoch 0, for a fork or a clone. Tells no listener. */
  inherit(ownerId: string, sourceId: string, targetId: string): void;
  /** Called after a session's mode or taint changed. The returned function removes the listener. */
  onSessionChange(listener: (ownerId: string, sessionId: string) => void): () => void;
  /** Called after an owner's settings were saved. The returned function removes the listener. */
  onSettingsChange(listener: (ownerId: string) => void): () => void;
}

type AuditLine = Parameters<AuditPort["append"]>[0];

const MAX_SETTINGS_BYTES = 65_536;
const MAX_LOGGED_OWNERS = 1_024;

export function createSessionPolicyService(deps: {
  readonly sessions: SessionPolicyStore;
  readonly settings: SettingsPolicyStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditPort;
  /** Who owns a session; bound late, because the sessions module exists after this one (M5R56). */
  sessionOwner(sessionId: string): string | null;
}) {
  const sessionListeners = new Set<(ownerId: string, sessionId: string) => void>();
  const settingsListeners = new Set<(ownerId: string) => void>();
  // A failing listener (a worker that went away) must not stop the others nor fail the answer that caused the change.
  const tell = <A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A) => {
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch (error) {
        deps.logger.warn("policy_listener_failed", { err: error });
      }
    }
  };
  const sessionChanged = (ownerId: string, sessionId: string) => tell(sessionListeners, ownerId, sessionId);

  // The unreadable-settings line is logged once per owner and boot; the memory is capped and starts over when full.
  const reported = new Set<string>();
  const reportUnreadable = (ownerId: string) => {
    if (reported.has(ownerId)) return;
    if (reported.size >= MAX_LOGGED_OWNERS) reported.clear();
    reported.add(ownerId);
    deps.logger.warn("policy_settings_unreadable", {});
  };

  const parseStored = (text: string): PolicySettings | null => {
    try {
      const parsed = PolicySettings.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const settings = (ownerId: string): PolicySettings => {
    const row = deps.settings.get(ownerId);
    if (!row) return DEFAULT_POLICY_SETTINGS;
    const value = parseStored(row.value);
    if (value) return value;
    reportUnreadable(ownerId);
    return RESTRICTIVE_SETTINGS;
  };

  const owns = (ownerId: string, sessionId: string): void => {
    // Another owner's session is `not_found`, the same as an unknown id: existence does not leak.
    if (deps.sessionOwner(sessionId) !== ownerId) throw new PapError("not_found");
  };

  const actorOf = (caller: Caller): { actor: AuditLine["actor"]; actorId?: string } => ({
    actor: caller.kind === "token" ? "token" : "user",
    ...(caller.credentialId ? { actorId: caller.credentialId } : {}),
  });

  return {
    sessionPolicy(ownerId: string, sessionId: string) {
      const row = deps.sessions.get(ownerId, sessionId);
      return {
        mode: row?.approvalMode ?? settings(ownerId).defaultMode,
        explicit: row?.approvalMode != null,
        taint: { tainted: row?.taintedAt != null, epoch: row?.taintEpoch ?? 0 },
      };
    },
    settings,
    markTainted(ownerId: string, sessionId: string): boolean {
      owns(ownerId, sessionId);
      const raised = deps.sessions.markTainted(ownerId, sessionId, deps.clock.now());
      if (raised) sessionChanged(ownerId, sessionId);
      return raised;
    },
    inherit(ownerId: string, sourceId: string, targetId: string): void {
      owns(ownerId, sourceId);
      owns(ownerId, targetId);
      deps.sessions.inherit(ownerId, sourceId, targetId, deps.clock.now());
    },
    setSessionMode(caller: Caller, sessionId: string, mode: ApprovalMode | null): void {
      owns(caller.userId, sessionId);
      deps.sessions.setMode(caller.userId, sessionId, mode, deps.clock.now());
      sessionChanged(caller.userId, sessionId);
      deps.audit.append({
        ownerId: caller.userId,
        ...actorOf(caller),
        kind: "policy",
        reason: "mode_changed",
        sessionId,
        detail: { mode: mode ?? "default" },
      });
    },
    clearTaint(caller: Caller, sessionId: string): void {
      owns(caller.userId, sessionId);
      deps.sessions.clearTaint(caller.userId, sessionId, deps.clock.now());
      sessionChanged(caller.userId, sessionId);
      deps.audit.append({
        ownerId: caller.userId,
        ...actorOf(caller),
        kind: "policy",
        reason: "taint_cleared",
        sessionId,
      });
    },
    /** `value: null` when nothing is stored or the stored document no longer parses: the client starts from the defaults. */
    getSettings(caller: Caller): { value: PolicySettings | null; revision: number } {
      const row = deps.settings.get(caller.userId);
      if (!row) return { value: null, revision: 0 };
      const value = parseStored(row.value);
      if (!value) reportUnreadable(caller.userId);
      return { value, revision: row.revision };
    },
    setSettings(caller: Caller, input: unknown, baseRevision: number): { revision: number } {
      const parsed = PolicySettings.safeParse(input);
      if (!parsed.success) throw new PapError("bad_request");
      const text = JSON.stringify(parsed.data);
      if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) throw new PapError("bad_request");
      // Compare-and-set (owner R3-4): a write based on a revision that moved never lands over the newer copy.
      const revision = deps.settings.put(caller.userId, text, baseRevision, deps.clock.now());
      if (revision === null) throw new PapError("conflict");
      tell(settingsListeners, caller.userId);
      const value = parsed.data;
      deps.audit.append({
        ownerId: caller.userId,
        ...actorOf(caller),
        kind: "policy",
        reason: "settings_changed",
        detail: {
          denylistCount: value.denylist.length,
          hostCount: value.allowHosts === null ? null : value.allowHosts.length,
          defaultMode: value.defaultMode,
          builtinDenylist: value.builtinDenylist,
        },
      });
      return { revision };
    },
    onSessionChange(listener: (ownerId: string, sessionId: string) => void): () => void {
      sessionListeners.add(listener);
      return () => void sessionListeners.delete(listener);
    },
    onSettingsChange(listener: (ownerId: string) => void): () => void {
      settingsListeners.add(listener);
      return () => void settingsListeners.delete(listener);
    },
  };
}
export type SessionPolicyService = ReturnType<typeof createSessionPolicyService>;
