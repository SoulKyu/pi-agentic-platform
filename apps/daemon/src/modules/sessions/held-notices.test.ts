import { describe, expect, it, vi } from "vitest";
import { createHeldNotices, MAX_HELD_PER_SESSION, MAX_HELD_SESSIONS } from "./held-notices.ts";

/*
 * Mutants (RT-43), each run for real: `flush` drops what it holds without posting -> "posts what waited"; no per-session cap ->
 * "keeps a few per session"; the overflow not logged -> "writes a line for every notice finally dropped"; no session cap ->
 * "keeps a few sessions"; `flush` deletes the entry when a post fails -> "keeps the notices for the next start".
 */
function bed(live = true) {
  const posted: Array<[string, string]> = [];
  const warn = vi.fn();
  const held = createHeldNotices({
    post: (id, text) => (live ? (posted.push([id, text]), true) : false),
    logger: { warn },
  });
  return { held, posted, warn };
}

describe("notices for a session that is not live yet (I2)", () => {
  it("posts what waited, in order, once the session is live, and forgets it", () => {
    const { held, posted } = bed();
    held.hold("s1", "one");
    held.hold("s1", "two");
    held.hold("s2", "other");
    held.flush("s1");
    held.flush("s1");
    expect(posted).toEqual([
      ["s1", "one"],
      ["s1", "two"],
    ]);
  });

  it("keeps a few per session and writes a line for every notice finally dropped", () => {
    const { held, posted, warn } = bed();
    for (let i = 0; i < MAX_HELD_PER_SESSION + 2; i++) held.hold("s1", `n${i}`);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("mirror_notice_dropped", { sessionId: "s1", dropped: 1 });
    held.flush("s1");
    expect(posted.map(([, text]) => text)).toEqual(["n0", "n1", "n2", "n3"]);
  });

  it("keeps a few sessions: the oldest goes with a line", () => {
    const { held, posted, warn } = bed();
    for (let i = 0; i <= MAX_HELD_SESSIONS; i++) held.hold(`s${i}`, "x");
    expect(warn).toHaveBeenCalledExactlyOnceWith("mirror_notice_dropped", { sessionId: "s0", dropped: 1 });
    held.flush("s0");
    expect(posted).toEqual([]);
    held.flush(`s${MAX_HELD_SESSIONS}`);
    expect(posted).toHaveLength(1);
  });

  // AVM-E41 m3. Mutant: `flush` deletes the entry when a post fails -> the second flush posts nothing and this case fails.
  it("keeps the notices for the next start when the session did not go live, and posts them then", () => {
    const state = { live: false, posted: [] as string[] };
    const held = createHeldNotices({
      post: (_id, text) => (state.live ? (state.posted.push(text), true) : false),
      logger: { warn: vi.fn() },
    });
    held.hold("s1", "one");
    held.hold("s1", "two");
    held.flush("s1");
    expect(state.posted).toEqual([]);
    state.live = true;
    held.flush("s1");
    expect(state.posted).toEqual(["one", "two"]);
    held.flush("s1");
    expect(state.posted).toEqual(["one", "two"]);
  });

  it("keeps only what was not posted when the session stops being live part way", () => {
    let room = 1;
    const posted: string[] = [];
    const held = createHeldNotices({
      post: (_id, text) => (room-- > 0 ? (posted.push(text), true) : false),
      logger: { warn: vi.fn() },
    });
    held.hold("s1", "one");
    held.hold("s1", "two");
    held.flush("s1");
    expect(posted).toEqual(["one"]);
    room = 5;
    held.flush("s1");
    expect(posted).toEqual(["one", "two"]);
  });
});
