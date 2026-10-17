import type { Db } from "../../kernel/db/database.ts";

/** A `triggers` row as stored; `config` is the validated `TriggerInput` as JSON, parsed again by the reader. */
export interface TriggerRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly enabled: number;
  readonly source_type: string;
  readonly config: string;
  readonly cwd: string;
  /** The agent the trigger runs as (M11); null for a project trigger. */
  readonly agent_id: string | null;
  readonly project_id: string | null;
  readonly secret_rotated_at: number | null;
  readonly next_fire_at: number | null;
  readonly last_fire_at: number | null;
  readonly last_start_at: number | null;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NewTrigger {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly sourceType: string;
  readonly config: string;
  readonly cwd: string;
  readonly agentId: string | null;
  readonly projectId: string | null;
  readonly secretRotatedAt: number | null;
  readonly at: number;
}

export interface TriggerChange {
  readonly name: string;
  readonly enabled: boolean;
  readonly sourceType: string;
  readonly config: string;
  readonly cwd: string;
  readonly agentId: string | null;
  readonly projectId: string | null;
  /** The new value of `secret_rotated_at`; `undefined` leaves the column alone. */
  readonly secretRotatedAt?: number | null;
  readonly at: number;
}

/** The only writer of `triggers` (C §3.2). Every statement names the owner; another owner's row is never touched. */
export function createTriggerStore(db: Db) {
  return {
    get: (ownerId: string, id: string): TriggerRow | undefined =>
      db.get<TriggerRow>("SELECT * FROM triggers WHERE id = $id AND owner_id = $ownerId", { id, ownerId }),

    /** The owner of a trigger, for the hook route: it has a trigger id and no caller. */
    ownerOf: (id: string): string | undefined =>
      db.get<{ owner_id: string }>("SELECT owner_id FROM triggers WHERE id = $id", { id })?.owner_id,

    list: (ownerId: string, projectId: string | undefined): TriggerRow[] =>
      projectId === undefined
        ? db.all<TriggerRow>("SELECT * FROM triggers WHERE owner_id = $ownerId ORDER BY created_at, id", {
            ownerId,
          })
        : db.all<TriggerRow>(
            "SELECT * FROM triggers WHERE owner_id = $ownerId AND project_id = $projectId ORDER BY created_at, id",
            { ownerId, projectId },
          ),

    /** The enabled triggers of every owner, for the scheduler and the feed poller. */
    listEnabled: (): TriggerRow[] =>
      db.all<TriggerRow>("SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at, id"),

    /** An agent's triggers, all of them (M11): the agent's delete removes them. */
    ofAgent: (ownerId: string, agentId: string): TriggerRow[] =>
      db.all<TriggerRow>("SELECT * FROM triggers WHERE owner_id = $ownerId AND agent_id = $agentId", {
        ownerId,
        agentId,
      }),

    count: (ownerId: string): number =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM triggers WHERE owner_id = $ownerId", { ownerId })?.n ??
      0,

    insert(trigger: NewTrigger): void {
      db.run(
        `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, agent_id, project_id, secret_rotated_at,
           revision, created_at, updated_at)
         VALUES ($id, $ownerId, $name, $enabled, $sourceType, $config, $cwd, $agentId, $projectId, $secretRotatedAt, 1, $at, $at)`,
        {
          id: trigger.id,
          ownerId: trigger.ownerId,
          name: trigger.name,
          enabled: trigger.enabled ? 1 : 0,
          sourceType: trigger.sourceType,
          config: trigger.config,
          cwd: trigger.cwd,
          agentId: trigger.agentId,
          projectId: trigger.projectId,
          secretRotatedAt: trigger.secretRotatedAt,
          at: trigger.at,
        },
      );
    },

    /** Compare-and-set on the revision (M10R22): true when this call changed the row. The next fire is recomputed by its scheduler. */
    update(ownerId: string, id: string, baseRevision: number, change: TriggerChange): boolean {
      const keepRotation = change.secretRotatedAt === undefined;
      return (
        db.run(
          `UPDATE triggers SET name = $name, enabled = $enabled, source_type = $sourceType, config = $config, cwd = $cwd,
             agent_id = $agentId, project_id = $projectId, secret_rotated_at = CASE WHEN $keep = 1 THEN secret_rotated_at ELSE $rotatedAt END,
             next_fire_at = NULL, revision = revision + 1, updated_at = $at
           WHERE id = $id AND owner_id = $ownerId AND revision = $baseRevision`,
          {
            id,
            ownerId,
            baseRevision,
            name: change.name,
            enabled: change.enabled ? 1 : 0,
            sourceType: change.sourceType,
            config: change.config,
            cwd: change.cwd,
            agentId: change.agentId,
            projectId: change.projectId,
            keep: keepRotation ? 1 : 0,
            rotatedAt: change.secretRotatedAt ?? null,
            at: change.at,
          },
        ).changes === 1
      );
    },

    setEnabled: (ownerId: string, id: string, enabled: boolean, at: number): boolean =>
      db.run(
        `UPDATE triggers SET enabled = $enabled, revision = revision + 1, updated_at = $at
         WHERE id = $id AND owner_id = $ownerId`,
        { id, ownerId, enabled: enabled ? 1 : 0, at },
      ).changes === 1,

    setRotatedAt: (ownerId: string, id: string, at: number): boolean =>
      db.run("UPDATE triggers SET secret_rotated_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    /** The scheduler's next occurrence of a trigger (null: none armed). It does not touch the revision. */
    setNextFire: (ownerId: string, id: string, at: number | null): boolean =>
      db.run("UPDATE triggers SET next_fire_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    /** A disabled trigger arms nothing; re-enabling it computes the next occurrence from then, never a stale one. */
    clearDisabledNextFire: (): number =>
      db.run("UPDATE triggers SET next_fire_at = NULL WHERE enabled = 0 AND next_fire_at IS NOT NULL")
        .changes,

    /** A fire reached the queue (the fire path, M10R34). */
    markFired: (ownerId: string, id: string, at: number): boolean =>
      db.run("UPDATE triggers SET last_fire_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    /** A task of the trigger started: the admission serves the trigger that started longest ago first (RT-10). */
    markStarted: (ownerId: string, id: string, at: number): boolean =>
      db.run("UPDATE triggers SET last_start_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    remove: (ownerId: string, id: string): boolean =>
      db.run("DELETE FROM triggers WHERE id = $id AND owner_id = $ownerId", { id, ownerId }).changes === 1,

    transaction: <T>(fn: () => T): T => db.transaction(fn),
  };
}
export type TriggerStore = ReturnType<typeof createTriggerStore>;
