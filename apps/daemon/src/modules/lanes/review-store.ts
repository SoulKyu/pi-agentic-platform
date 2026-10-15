import type { Db } from "../../kernel/db/database.ts";

export interface ReviewRow {
  readonly doc: string;
  readonly revision: number;
}

export interface ReviewStore {
  get(ownerId: string, laneId: string): ReviewRow | undefined;
  /**
   * Compare-and-set in one statement (the settings pattern): writes only when the stored revision is `baseRevision`
   * (0 = no row yet) and returns the new revision, or null when the row moved or appeared meanwhile.
   */
  put(ownerId: string, laneId: string, doc: string, baseRevision: number): number | null;
}

/** `lane_reviews`: written here only. The row stays with an archived lane, as its record (M9R78). */
export function createReviewStore(db: Db): ReviewStore {
  return {
    get: (ownerId, laneId) =>
      db.get<ReviewRow>(
        "SELECT doc, revision FROM lane_reviews WHERE lane_id = $laneId AND owner_id = $ownerId",
        {
          laneId,
          ownerId,
        },
      ),
    put: (ownerId, laneId, doc, baseRevision) =>
      (baseRevision === 0
        ? db.get<{ revision: number }>(
            "INSERT INTO lane_reviews (lane_id, owner_id, doc, revision) VALUES ($laneId, $ownerId, $doc, 1) " +
              "ON CONFLICT (lane_id) DO NOTHING RETURNING revision",
            { laneId, ownerId, doc },
          )
        : db.get<{ revision: number }>(
            "UPDATE lane_reviews SET doc = $doc, revision = revision + 1 " +
              "WHERE lane_id = $laneId AND owner_id = $ownerId AND revision = $baseRevision RETURNING revision",
            { laneId, ownerId, doc, baseRevision },
          )
      )?.revision ?? null,
  };
}
