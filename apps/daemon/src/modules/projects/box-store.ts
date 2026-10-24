import {
  type AgentResources,
  AgentResources as AgentResourcesSchema,
  DEFAULT_PROJECT_RESOURCES,
} from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export interface BoxRecord {
  readonly projectId: string;
  readonly ownerId: string;
  readonly root: string;
  readonly resources: AgentResources;
  readonly hosts: readonly string[];
  readonly scratch: boolean;
  readonly deleting: boolean;
}

interface RawBox {
  projectId: string;
  ownerId: string;
  root: string;
  resources: string;
  hosts: string;
  scratch: number;
  deleting: number;
}

export interface BoxStore {
  /** A project's box record whoever owns it: the guest-facing source reads it by id. */
  get(projectId: string): BoxRecord | undefined;
  ofOwner(ownerId: string): BoxRecord[];
  scratchOf(ownerId: string): BoxRecord | undefined;
  insert(box: {
    projectId: string;
    resources: AgentResources;
    hosts: readonly string[];
    scratch: boolean;
  }): void;
  set(projectId: string, change: { resources?: AgentResources; hosts?: readonly string[] }): void;
  markDeleting(projectId: string): void;
  /** The box record and the project row, in one transaction. */
  remove(projectId: string): void;
}

const SELECT = `SELECT p.id AS projectId, p.owner_id AS ownerId, p.root AS root, b.resources AS resources,
  b.hosts AS hosts, b.scratch AS scratch, b.deleting AS deleting
  FROM project_boxes b JOIN projects p ON p.id = b.project_id`;

const resourcesOf = (text: string): AgentResources => {
  try {
    const parsed = AgentResourcesSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // A row nobody wrote through the service: the defaults, never a crash of the shell snapshot.
  }
  return DEFAULT_PROJECT_RESOURCES;
};
const hostsOf = (text: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
};
const recordOf = (raw: RawBox): BoxRecord => ({
  projectId: raw.projectId,
  ownerId: raw.ownerId,
  root: raw.root,
  resources: resourcesOf(raw.resources),
  hosts: hostsOf(raw.hosts),
  scratch: raw.scratch === 1,
  deleting: raw.deleting === 1,
});

export function createBoxStore(db: Db): BoxStore {
  return {
    get: (projectId) => {
      const raw = db.get<RawBox>(`${SELECT} WHERE b.project_id = $projectId`, { projectId });
      return raw && recordOf(raw);
    },
    ofOwner: (ownerId) => db.all<RawBox>(`${SELECT} WHERE p.owner_id = $ownerId`, { ownerId }).map(recordOf),
    scratchOf: (ownerId) => {
      const raw = db.get<RawBox>(
        `${SELECT} WHERE p.owner_id = $ownerId AND b.scratch = 1 AND b.deleting = 0`,
        { ownerId },
      );
      return raw && recordOf(raw);
    },
    insert: (box) => {
      db.run(
        "INSERT INTO project_boxes (project_id, resources, hosts, scratch) VALUES ($projectId, $resources, $hosts, $scratch)",
        {
          projectId: box.projectId,
          resources: JSON.stringify(box.resources),
          hosts: JSON.stringify(box.hosts),
          scratch: box.scratch ? 1 : 0,
        },
      );
    },
    set: (projectId, change) => {
      db.transaction(() => {
        if (change.resources)
          db.run("UPDATE project_boxes SET resources = $value WHERE project_id = $projectId", {
            projectId,
            value: JSON.stringify(change.resources),
          });
        if (change.hosts)
          db.run("UPDATE project_boxes SET hosts = $value WHERE project_id = $projectId", {
            projectId,
            value: JSON.stringify(change.hosts),
          });
      });
    },
    markDeleting: (projectId) => {
      db.run("UPDATE project_boxes SET deleting = 1 WHERE project_id = $projectId", { projectId });
    },
    remove: (projectId) => {
      db.transaction(() => {
        db.run("DELETE FROM project_boxes WHERE project_id = $projectId", { projectId });
        db.run("DELETE FROM projects WHERE id = $projectId", { projectId });
      });
    },
  };
}
