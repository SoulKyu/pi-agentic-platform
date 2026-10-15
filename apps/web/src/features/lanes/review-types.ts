import type { ReviewList } from "@pap/contracts";
import type { ResultOf } from "@pap/contracts";

/** The contract exports these as schemas only; the types come from the lists that carry them. */
export type ReviewFile = ReviewList["files"][number];
export type LaneTurn = ResultOf<"lanes.turns">["turns"][number];
