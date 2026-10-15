import { lanesMethods } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import * as lanes from "./index.ts";
import { IMPLEMENTED as CONFIG } from "./rpc-config.ts";
import { IMPLEMENTED as ARCHIVE } from "./rpc-archive.ts";
import { IMPLEMENTED as CHECKPOINTS } from "./rpc-checkpoints.ts";
import { IMPLEMENTED as CORE } from "./rpc-core.ts";
import { IMPLEMENTED as FANOUT } from "./rpc-fanout.ts";
import { IMPLEMENTED as GIT } from "./rpc-git.ts";
import { IMPLEMENTED as ISSUE } from "./rpc-issue.ts";
import { IMPLEMENTED as REVIEW } from "./rpc-review.ts";
import { IMPLEMENTED as SCRIPTS } from "./rpc-scripts.ts";
import { IMPLEMENTED as SUGGEST } from "./rpc-suggest.ts";

describe("the lanes handler table", () => {
  it("serves every lanes method of the catalogue exactly once, with no pending handler left", () => {
    const served = [
      ...CONFIG,
      ...SCRIPTS,
      ...CORE,
      ...ARCHIVE,
      ...GIT,
      ...CHECKPOINTS,
      ...ISSUE,
      ...FANOUT,
      ...REVIEW,
      ...SUGGEST,
    ].sort();
    expect(served).toEqual(Object.keys(lanesMethods).sort());
    expect(new Set(served).size).toBe(served.length);
    expect(Object.keys(lanes)).not.toContain("lanesPending");
  });
});
