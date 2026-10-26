import { TOOL_PRESETS, type ToolPreset } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import type { TaskSessionPolicy } from "./automation-port.ts";
import type { ChildSessionPolicy } from "./child-port.ts";
import { createMarksStore, type MarksStore } from "./marks-store.ts";

export interface SessionRow {
  /** The session's own id: what the client and the stream use. Pi's id for the same session lives in `piSessionId`. */
  readonly id: string;
  /** Absolute path of Pi's file; null for a draft, a session Pi has not written a file for yet. */
  readonly piPath: string | null;
  /** The uuid in that file's header; null exactly when `piPath` is. */
  readonly piSessionId: string | null;
  readonly cwd: string;
  readonly ownerId: string;
  /** Pi's name for the session as the worker last said it (clipped by `nameOf`); null when it has none. */
  readonly name: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The session's tool preset when it has one; absent follows Pi's default tools ("configured", M7R76). */
  readonly toolPreset?: StoredPreset | undefined;
  /** A new task session's policy while its row is not stored: never read back from the store (M10R31). */
  readonly task?: TaskSessionPolicy | undefined;
  /** A relaunched task session's kept folder key, derived at each launch from its running task (I2): never stored. */
  readonly keptKey?: string | undefined;
  /** A new child session's policy while its row is not stored, like `task`: never read back from the store (M11R136). */
  readonly child?: ChildSessionPolicy | undefined;
  /** The agent the session belongs to, its role there, and the session it is a child of (M11R35): set at insert, never changed. */
  readonly agentId?: string | undefined;
  readonly agentRole?: "thread" | "task" | "child" | undefined;
  /** The owner's own tool choice on an agent thread (W5-R28); absent until `sessions.setTools` sets one. */
  readonly ownerPreset?: ToolPreset | undefined;
  readonly parentSessionId?: string | undefined;
}

/** What the column can hold: `configured` is NULL, not a value. */
export type StoredPreset = Exclude<ToolPreset, "configured">;

/** The value to store for a preset the caller chose. */
export const storedPresetOf = (preset: ToolPreset): StoredPreset | null =>
  preset === "configured" ? null : preset;

/**
 * The preset a stored value means. A value this version does not know (a row a newer pap wrote) is read as `chat`, the
 * narrowest preset, never as the looser `configured`: unreadable means restricted.
 */
export function toolPresetOf(raw: unknown): StoredPreset | null {
  if (raw === null || raw === undefined) return null;
  return (TOOL_PRESETS as readonly unknown[]).includes(raw) && raw !== "configured"
    ? (raw as StoredPreset)
    : "chat";
}

export interface SessionsStore {
  /** The database is one a newer pap wrote: nothing may be written (RT-04). */
  readonly readOnly: boolean;
  /** The M4 columns of the same table: marks, project, preview, pending Pi id. */
  readonly marks: MarksStore;
  /** `projectId` comes from `project-link.ts`; none when the session is filed later. */
  insert(row: SessionRow, projectId?: string | null): void;
  get(id: string): SessionRow | undefined;
  /** The stored preset of a session (null: configured), read as `toolPresetOf` reads it. */
  toolPreset(id: string): StoredPreset | null;
  setToolPreset(id: string, preset: StoredPreset | null): void;
  /** The owner's choice on an agent thread (W5-R28); `configured` is kept as written. */
  setOwnerPreset(id: string, preset: ToolPreset): void;
  listByOwner(ownerId: string): SessionRow[];
  /** The folders the sessions of isolated agent tasks work in: a scratch folder one of them names is not an orphan. */
  taskFolders(): ReadonlySet<string>;
  touch(id: string, at: number): void;
  /** Removes a row (and, by cascade, what hangs on it); for a fork or clone that failed after its insert. */
  remove(id: string): void;
  /** Caches Pi's name for listings; the CHECK refuses what `nameOf` would not return. */
  setName(id: string, name: string | null): void;
  /** Sets the Pi file of a draft, once. False when the session already has one. Throws when another session owns the path. */
  bindPiFile(id: string, piPath: string, piSessionId: string): boolean;
  /** When pap last wrote the session's Pi file and how long the file was then; null where nothing is known. */
  papWrote(id: string): { at: number | null; size: number | null };
  setPapWrote(id: string, at: number | null, size: number | null): void;
  /** Runs `fn` in one transaction (nesting joins the outer one): all of it is written, or none. */
  transaction<T>(fn: () => T): T;
  appendEvent(sessionId: string, kind: string, data: unknown, at: number): void;
}

const COLUMNS =
  "id, pi_path AS piPath, pi_session_id AS piSessionId, cwd, owner_id AS ownerId, name, created_at AS createdAt, updated_at AS updatedAt, tool_preset AS toolPreset, agent_id AS agentId, agent_role AS agentRole, parent_session_id AS parentSessionId, owner_preset AS ownerPreset";

// A row without a preset has no `toolPreset` key, so the rows of sessions made before the column compare as they did.
function fit(raw: SessionRow | undefined): SessionRow | undefined {
  if (!raw) return raw;
  const { toolPreset, agentId, agentRole, parentSessionId, ownerPreset, ...rest } = raw;
  const preset = toolPresetOf(toolPreset);
  // The kind columns read NULL for most rows: such a row has no key, as before M11.
  const kind = Object.entries({ agentId, agentRole, parentSessionId, ownerPreset }).filter(
    ([, value]) => value != null,
  );
  return { ...rest, ...(preset === null ? {} : { toolPreset: preset }), ...Object.fromEntries(kind) };
}

export function createSessionsStore(db: Db): SessionsStore {
  return {
    readOnly: db.readOnly,
    marks: createMarksStore(db),
    insert: (row, projectId = null) => {
      db.run(
        "INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, project_id, created_at, updated_at, tool_preset, agent_id, agent_role, parent_session_id) VALUES ($id, $piPath, $piSessionId, $cwd, $ownerId, $name, $projectId, $createdAt, $updatedAt, $toolPreset, $agentId, $agentRole, $parentSessionId)",
        {
          id: row.id,
          piPath: row.piPath,
          piSessionId: row.piSessionId,
          cwd: row.cwd,
          ownerId: row.ownerId,
          name: row.name,
          projectId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          toolPreset: row.toolPreset ?? null,
          agentId: row.agentId ?? null,
          agentRole: row.agentRole ?? null,
          parentSessionId: row.parentSessionId ?? null,
        },
      );
    },
    get: (id) => fit(db.get<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = $id`, { id })),
    toolPreset: (id) =>
      toolPresetOf(
        db.get<{ preset: unknown }>("SELECT tool_preset AS preset FROM sessions WHERE id = $id", { id })
          ?.preset,
      ),
    setToolPreset: (id, preset) => {
      db.run("UPDATE sessions SET tool_preset = $preset WHERE id = $id", { id, preset });
    },
    setOwnerPreset: (id, preset) => {
      db.run("UPDATE sessions SET owner_preset = $preset WHERE id = $id", { id, preset });
    },
    listByOwner: (ownerId) =>
      db
        .all<SessionRow>(
          `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId ORDER BY updated_at DESC, id`,
          { ownerId },
        )
        .map((row) => fit(row) as SessionRow),
    taskFolders: () =>
      new Set(
        db.all<{ cwd: string }>("SELECT cwd FROM sessions WHERE agent_role = 'task'").map((row) => row.cwd),
      ),
    touch: (id, at) => {
      db.run("UPDATE sessions SET updated_at = $at WHERE id = $id", { id, at });
    },
    remove: (id) => {
      db.run("DELETE FROM sessions WHERE id = $id", { id });
    },
    setName: (id, name) => {
      db.run("UPDATE sessions SET name = $name WHERE id = $id", { id, name });
    },
    bindPiFile: (id, piPath, piSessionId) =>
      db.run(
        "UPDATE sessions SET pi_path = $piPath, pi_session_id = $piSessionId WHERE id = $id AND pi_path IS NULL",
        { id, piPath, piSessionId },
      ).changes > 0,
    papWrote: (id) =>
      db.get<{ at: number | null; size: number | null }>(
        "SELECT pap_wrote_at AS at, pap_wrote_size AS size FROM sessions WHERE id = $id",
        { id },
      ) ?? { at: null, size: null },
    setPapWrote: (id, at, size) => {
      db.run("UPDATE sessions SET pap_wrote_at = $at, pap_wrote_size = $size WHERE id = $id", {
        id,
        at,
        size,
      });
    },
    transaction: (fn) => db.transaction(fn),
    appendEvent: (sessionId, kind, data, at) => {
      db.run(
        "INSERT INTO session_events (session_id, kind, data, created_at) VALUES ($sessionId, $kind, $data, $at)",
        { sessionId, kind, data: JSON.stringify(data ?? null), at },
      );
    },
  };
}
