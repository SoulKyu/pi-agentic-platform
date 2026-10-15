import { LANE_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLaneNotices } from "./notices.ts";

const make = () => {
  const clock = createFakeClock();
  const changed: string[] = [];
  const notices = createLaneNotices(clock, (laneId) => void changed.push(laneId));
  return { clock, changed, notices };
};

describe("lane notices", () => {
  it("keeps the newest 8 of a lane: the ninth drops the oldest of that lane only", async () => {
    const { clock, notices } = make();
    notices.add("other-0001", "copy_skipped", 1);
    for (let n = 1; n <= 9; n++) {
      notices.add("a-0001", "copy_skipped", n);
      await clock.advance(1);
    }
    const list = notices.list("a-0001");
    expect(LANE_LIMITS.notices).toBe(8);
    expect(list.map((notice) => notice.count)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(notices.list("other-0001")).toHaveLength(1);
  });

  it("carries a kind, a time and a count (null when none), never a name", () => {
    const { clock, notices } = make();
    notices.add("a-0001", "model_refused");
    expect(notices.list("a-0001")).toEqual([{ kind: "model_refused", at: clock.now(), count: null }]);
  });

  it("publishes the lane after each notice", () => {
    const { changed, notices } = make();
    notices.add("a-0001", "session_failed");
    notices.add("b-0001", "disk_low", 3);
    expect(changed).toEqual(["a-0001", "b-0001"]);
  });

  it("forgets a lane", () => {
    const { notices } = make();
    notices.add("a-0001", "session_failed");
    notices.forget("a-0001");
    expect(notices.list("a-0001")).toEqual([]);
  });
});
