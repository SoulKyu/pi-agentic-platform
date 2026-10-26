import { join } from "node:path";
import {
  AUTOMATION_LIMITS,
  type Caller,
  PapError,
  type ParamsOf,
  type ResultOf,
  type TaskTrigger,
  TriggerInput,
  type TriggerView,
} from "@pap/contracts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { IsMember } from "../../kernel/box-path.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { newId } from "../../kernel/ids.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { boxCwdOf, gatedBoxCwdOf, resolveSessionCwd } from "../sessions/index.ts";
import { newHookSecret } from "./hook-auth.ts";
import { feedUrlRefusal } from "./net-guard.ts";
import { createKeptForgetter } from "./kept-folder.ts";
import { isStateFolder } from "./trigger-folder.ts";
import { createTriggerStore, type TriggerRow } from "./store.ts";
import { agrees, type AgentBinding, resolveExecution } from "./trigger-agent.ts";
import { removeTriggerSecret, writeTriggerSecret } from "./trigger-secrets.ts";
import { redactedFeedUrl, stateOf, summaryOf } from "./trigger-summaries.ts";

export interface TriggersDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: Pick<AuditPort, "append">;
  readonly projects: Pick<ProjectsPort, "ensure">;
  /** The root a folder is filed under as a project, as the sessions module does it. */
  scopeOf(cwd: string): string;
  /** The owner's box projects, bound late: a folder under a box root is kept as given and files under its project. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly isMember: IsMember;
  readonly config: { readonly home: string; readonly piAgentDir: string; readonly publicOrigin: string };
  /** The auth module's password step-up: throws `step_up_required`. */
  requireStepUp(caller: Caller, now: number): void;
  /** After a trigger was saved, switched, rotated or deleted: the `tasks` stream lists triggers. A throw is logged. */
  onChange?(change: TriggerChanged): void;
  readonly agents?: AgentBinding;
}

export interface TriggerChanged {
  readonly ownerId: string;
  readonly triggerId: string;
  readonly removed: boolean;
}

/** A trigger as the other automation tasks read it: `input` is null when the stored config no longer parses (M10R21). */
export interface TriggerRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly sourceType: string;
  readonly input: TriggerInput | null;
  readonly cwd: string;
  readonly agentId: string | null;
  readonly projectId: string | null;
  readonly secretRotatedAt: number | null;
  readonly nextFireAt: number | null;
  readonly lastFireAt: number | null;
  readonly lastStartAt: number | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type AuditReason = "created" | "updated" | "deleted" | "enabled" | "disabled" | "secret rotated";

const CONFIG_MAX_CHARS = 65_536;
const VIEW_ENVELOPE_BYTES = sizeOf({ triggers: [], truncated: true });

/** `automation` is an internal credential name (agreement 17); everything else is the caller. */
function actorOf(caller: Caller): { actor: "user" | "token" | "system"; actorId: string } {
  const actorId = caller.credentialId.slice(0, 128);
  if (caller.credentialId === "automation") return { actor: "system", actorId };
  return { actor: caller.kind === "token" ? "token" : "user", actorId };
}

/** A feed address that can never be fetched (a literal private address, http, credentials) is not saved (M10R158). */
function refuseUnfetchableFeed(input: TriggerInput): void {
  if (input.source.type === "feed" && feedUrlRefusal(new URL(input.source.url)) !== null)
    throw new PapError("bad_request");
}

export function createTriggers(deps: TriggersDeps) {
  const store = createTriggerStore(deps.db);
  const secretsDir = join(deps.config.home, "secrets", "triggers");
  const forgetKept = createKeptForgetter(deps, (ownerId, id) => find(ownerId, id)?.input ?? null);

  function recordOf(row: TriggerRow): TriggerRecord {
    let input: TriggerInput | null = null;
    try {
      const parsed = TriggerInput.safeParse(JSON.parse(row.config) as unknown);
      if (parsed.success && agrees(parsed.data, row)) input = { ...parsed.data, enabled: row.enabled === 1 };
    } catch {
      input = null;
    }
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      enabled: row.enabled === 1,
      sourceType: row.source_type,
      input,
      cwd: row.cwd,
      agentId: row.agent_id,
      projectId: row.project_id,
      secretRotatedAt: row.secret_rotated_at,
      nextFireAt: row.next_fire_at,
      lastFireAt: row.last_fire_at,
      lastStartAt: row.last_start_at,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function owned(ownerId: string, id: string): TriggerRecord {
    const row = store.get(ownerId, id);
    if (!row) throw new PapError("not_found");
    return recordOf(row);
  }

  /** The stream hears of a change after it happened; whatever it throws never fails the owner's save. */
  function notify(ownerId: string, triggerId: string, removed: boolean): void {
    try {
      deps.onChange?.({ ownerId, triggerId, removed });
    } catch (error) {
      deps.logger.warn("trigger_change_listener_failed", { err: error });
    }
  }

  function viewOf(record: TriggerRecord, redacted: boolean): TriggerView {
    const { input } = record;
    const execution =
      input === null ? null : redacted ? { ...input.execution, precheck: null, env: [] } : input.execution;
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      state: stateOf(record, secretsDir),
      source:
        redacted && input?.source.type === "feed"
          ? { ...input.source, url: redactedFeedUrl(input.source.url) }
          : (input?.source ?? null),
      execution,
      agent: input?.execution.agent ?? null,
      prompt: input?.prompt ?? null,
      projectId: record.projectId,
      cwd: record.cwd,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      webhookUrl: record.sourceType === "webhook" ? `${deps.config.publicOrigin}/hooks/${record.id}` : null,
      secretRotatedAt: record.secretRotatedAt,
      nextFireAt: record.nextFireAt,
      lastFireAt: record.lastFireAt,
      redacted,
    };
  }

  /** The folder follows `sessions.create`'s rule, and is never pap's or Pi's own state (M10R20). */
  function folderOf(cwd: string, ownerId: string): string {
    const box = gatedBoxCwdOf(deps.boxes?.(), ownerId, cwd, deps.isMember);
    if (box) return box.cwd;
    const real = resolveSessionCwd(cwd);
    if (isStateFolder(real, [deps.config.home, deps.config.piAgentDir])) throw new PapError("invalid_cwd");
    return real;
  }

  function projectOf(ownerId: string, cwd: string, agentId: string | null): string | null {
    // An agent's home is never filed as a project (decision 85).
    if (agentId !== null) return null;
    const box = boxCwdOf(deps.boxes?.(), ownerId, cwd);
    if (box) return box.projectId;
    if (deps.isMember(ownerId)) return null;
    try {
      return deps.projects.ensure(ownerId, deps.scopeOf(cwd))?.id ?? null;
    } catch (error) {
      deps.logger.warn("trigger_project_failed", { err: error });
      return null;
    }
  }

  /** One row per change, never the prompt, the command, the folder or the secret (M10R23). */
  function audit(caller: Caller, reason: AuditReason, record: TriggerRecord): void {
    const { input } = record;
    deps.audit.append({
      ownerId: caller.userId,
      ...actorOf(caller),
      kind: "policy",
      reason: `automation trigger ${reason}`,
      detail: {
        triggerId: record.id,
        source: record.sourceType,
        mode: input?.execution.mode ?? null,
        tools: input?.execution.tools.length ?? 0,
        precheck: input ? input.execution.precheck !== null : false,
      },
    });
  }

  /** The validated input with the real folder, as stored; `enabled` lives in its own column. */
  function configOf(input: TriggerInput, cwd: string): string {
    const config = JSON.stringify({
      name: input.name,
      source: input.source,
      execution: input.execution.agent ? input.execution : { ...input.execution, cwd },
      prompt: input.prompt,
    });
    if (config.length > CONFIG_MAX_CHARS) throw new PapError("bad_request");
    return config;
  }

  function dropSecret(id: string): void {
    try {
      removeTriggerSecret(secretsDir, id);
    } catch (error) {
      deps.logger.warn("trigger_secret_remove_failed", { err: error });
    }
  }

  const find = (ownerId: string, id: string): TriggerRecord | null => {
    const row = store.get(ownerId, id);
    return row ? recordOf(row) : null;
  };
  return {
    // Reads for the other automation tasks (the runner, the scheduler, the hook route); `kept` forgets kept folders.
    kept: forgetKept,
    get: find,
    /** The folder a task starts in, checked as when the trigger was saved (`invalid_cwd`; never pap's own state). */
    resolveFolder: folderOf,
    /** What the Tasks board lists of an owner's triggers (no config, no secret), capped at the per-owner limit. */
    summaries: (ownerId: string): TaskTrigger[] =>
      store.list(ownerId, undefined).map((row) => summaryOf(recordOf(row), secretsDir)),
    summary(ownerId: string, id: string): TaskTrigger | null {
      const record = find(ownerId, id);
      return record && summaryOf(record, secretsDir);
    },
    /** The trigger only while it is still at `revision`: a task started from an edit that was replaced does not run. */
    getAt(ownerId: string, id: string, revision: number): TriggerRecord | null {
      const record = find(ownerId, id);
      return record && record.revision === revision ? record : null;
    },
    /** Enabled triggers that parse, of every owner: an unreadable row never fires. */
    listEnabled: (): TriggerRecord[] =>
      store
        .listEnabled()
        .map(recordOf)
        .filter((record) => record.input !== null),

    view(caller: Caller, triggerId: string): TriggerView {
      return viewOf(owned(caller.userId, triggerId), caller.kind === "token");
    },

    list(caller: Caller, params: ParamsOf<"automation.triggers.list">): ResultOf<"automation.triggers.list"> {
      const redacted = caller.kind === "token";
      const triggers: TriggerView[] = [];
      let used = VIEW_ENVELOPE_BYTES;
      let truncated = false;
      for (const row of store.list(caller.userId, params.projectId)) {
        const view = viewOf(recordOf(row), redacted);
        const size = sizeOf(view) + 1;
        if (used + size > PAGE_BYTES) {
          truncated = true;
          break;
        }
        used += size;
        triggers.push(view);
      }
      return { triggers, truncated };
    },

    create(caller: Caller, input: TriggerInput): ResultOf<"automation.triggers.create"> {
      deps.requireStepUp(caller, deps.clock.now());
      refuseUnfetchableFeed(input);
      const { cwd, agentId } = resolveExecution(deps.agents, caller.userId, input.execution, folderOf);
      const config = configOf(input, cwd);
      // Nothing is written for the 201st trigger, and no older one is evicted (M10R16).
      if (store.count(caller.userId) >= AUTOMATION_LIMITS.triggersPerOwner)
        throw new PapError("limit_reached");
      const id = newId();
      const now = deps.clock.now();
      const secret = input.source.type === "webhook" ? newHookSecret() : null;
      // The file first: a row without its file reads `no_secret`, but a file without its row cannot be reached.
      if (secret) writeTriggerSecret(secretsDir, id, secret);
      try {
        store.insert({
          id,
          ownerId: caller.userId,
          name: input.name,
          enabled: input.enabled,
          sourceType: input.source.type,
          config,
          cwd,
          agentId,
          projectId: projectOf(caller.userId, cwd, agentId),
          secretRotatedAt: secret ? now : null,
          at: now,
        });
      } catch (error) {
        if (secret) dropSecret(id);
        throw error;
      }
      const record = owned(caller.userId, id);
      audit(caller, "created", record);
      notify(caller.userId, id, false);
      return { trigger: viewOf(record, false), secret };
    },

    update(
      caller: Caller,
      params: ParamsOf<"automation.triggers.update">,
    ): ResultOf<"automation.triggers.update"> {
      deps.requireStepUp(caller, deps.clock.now());
      const { triggerId, baseRevision, input } = params;
      const before = owned(caller.userId, triggerId);
      if (before.revision !== baseRevision) throw new PapError("conflict");
      refuseUnfetchableFeed(input);
      const { cwd, agentId } = resolveExecution(deps.agents, caller.userId, input.execution, folderOf);
      const config = configOf(input, cwd);
      const now = deps.clock.now();
      const isWebhook = input.source.type === "webhook";
      // A webhook that was not one gets a secret; one that stays a webhook keeps its own; one that leaves loses it.
      // A secret that travelled in clear in a header must not become the HMAC key (M10R18): secret to hmac issues a new one.
      const was = before.input?.source;
      const fresh =
        was?.type !== "webhook" ||
        (was.auth === "secret" && input.source.type === "webhook" && input.source.auth === "hmac");
      const secret = isWebhook && fresh ? newHookSecret() : null;
      if (secret) writeTriggerSecret(secretsDir, triggerId, secret);
      let changed: boolean;
      try {
        changed = store.update(caller.userId, triggerId, baseRevision, {
          name: input.name,
          enabled: input.enabled,
          sourceType: input.source.type,
          config,
          cwd,
          agentId,
          projectId: projectOf(caller.userId, cwd, agentId),
          ...(secret ? { secretRotatedAt: now } : isWebhook ? {} : { secretRotatedAt: null }),
          at: now,
        });
      } catch (error) {
        if (secret && before.input !== null) dropSecret(triggerId);
        throw error;
      }
      if (!changed) throw new PapError("conflict");
      if (!isWebhook) dropSecret(triggerId);
      const record = owned(caller.userId, triggerId);
      forgetKept.changed(caller.userId, triggerId, before.input, input);
      audit(caller, "updated", record);
      notify(caller.userId, triggerId, false);
      return { trigger: viewOf(record, false), secret };
    },

    remove(caller: Caller, triggerId: string): { ok: true } {
      const record = owned(caller.userId, triggerId);
      store.remove(caller.userId, triggerId);
      forgetKept.changed(caller.userId, triggerId, record.input, null);
      dropSecret(triggerId);
      audit(caller, "deleted", record);
      notify(caller.userId, triggerId, true);
      return { ok: true };
    },

    setEnabled(caller: Caller, triggerId: string, enabled: boolean): TriggerView {
      owned(caller.userId, triggerId);
      store.setEnabled(caller.userId, triggerId, enabled, deps.clock.now());
      const record = owned(caller.userId, triggerId);
      audit(caller, enabled ? "enabled" : "disabled", record);
      notify(caller.userId, triggerId, false);
      return viewOf(record, caller.kind === "token");
    },

    /** The old secret stops working at once: the file is replaced, there is no grace (M10R18). `stepUpGiven`: a quarantine asked already (M11R115). */
    rotateSecret(caller: Caller, triggerId: string, stepUpGiven = false): { secret: string } {
      if (!stepUpGiven) deps.requireStepUp(caller, deps.clock.now());
      const record = owned(caller.userId, triggerId);
      if (record.input?.source.type !== "webhook") throw new PapError("bad_request");
      const secret = newHookSecret();
      writeTriggerSecret(secretsDir, triggerId, secret);
      store.setRotatedAt(caller.userId, triggerId, deps.clock.now());
      audit(caller, "secret rotated", record);
      notify(caller.userId, triggerId, false);
      return { secret };
    },
  };
}
export type Triggers = ReturnType<typeof createTriggers>;
