import type { Db } from "../../../kernel/db/database.ts";
import type { LaneRef } from "../index.ts";

let counter = 0;

/** A `lanes` row with only what the script runner reads; the rest takes the schema's required placeholders. */
export function insertLane(
  db: Db,
  input: { ownerId?: string; projectRoot?: string; worktree?: string; id?: string } = {},
): LaneRef {
  counter++;
  const lane: LaneRef = {
    id: input.id ?? `lane-${String(counter).padStart(4, "0")}`,
    ownerId: input.ownerId ?? "u1",
    projectRoot: input.projectRoot ?? "/srv/project",
    worktree: input.worktree ?? `/srv/worktrees/lane-${counter}`,
  };
  db.run(
    `INSERT INTO lanes (id, owner_id, created_by, project_root, worktree, branch, base_ref, base_oid, title, description, created_at)
     VALUES ($id, $ownerId, 'session', $projectRoot, $worktree, 'pi/x', 'main', $oid, 't', '', 1)`,
    {
      id: lane.id,
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
      oid: "a".repeat(40),
    },
  );
  return lane;
}
