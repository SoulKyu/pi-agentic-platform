// @vitest-environment happy-dom
import type { ReviewComment, ReviewDoc } from "@pap/contracts";
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { mount, settle } from "../../testing/dom.ts";
import { current, newBed } from "./lanes-bed.tsx";
import { addComment, deleteComment } from "./review.vm.ts";
import { useReviewState, type ReviewState } from "./use-review-state.ts";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const comment = (id: string): ReviewComment => ({
  id,
  path: "a.ts",
  side: "after",
  line: 1,
  excerpt: "x",
  body: id,
  createdAt: 1,
  sentAt: null,
  resolvedAt: null,
});
const doc = (...ids: string[]): ReviewDoc => ({ seen: [], comments: ids.map(comment) });

const seen: { state: ReviewState | null } = { state: null };
function Probe() {
  const value = useReviewState("a-1a2b");
  useEffect(() => {
    seen.state = value;
  });
  return <p>{value.status}</p>;
}
/** The state the last render of the probe held. */
const held = (): ReviewState => {
  if (seen.state === null) throw new Error("not rendered");
  return seen.state;
};
const open = async (
  server: { doc: ReviewDoc; revision: number },
  set?: (params: { doc: ReviewDoc; baseRevision: number }) => unknown,
) => {
  const bed = newBed();
  bed.handlers["lanes.reviewState.get"] = () => ({ doc: server.doc, revision: server.revision });
  bed.handlers["lanes.reviewState.set"] = (params) => {
    const asked = params as { doc: ReviewDoc; baseRevision: number };
    if (set) return set(asked);
    if (asked.baseRevision !== server.revision) throw new RpcError("conflict");
    server.doc = asked.doc;
    server.revision += 1;
    return { revision: server.revision };
  };
  await mount(<Probe />);
  await settle();
  return bed;
};
const run = async (mutate: (d: ReviewDoc) => ReviewDoc): Promise<boolean> => {
  let result = false;
  await act(async () => {
    result = await held().update(mutate);
  });
  return result;
};

describe("useReviewState", () => {
  it("reads the document and its revision", async () => {
    await open({ doc: doc("1"), revision: 3 });
    expect(held().status).toBe("ready");
    expect(held().doc.comments.map((c) => c.id)).toEqual(["1"]);
  });

  it("saves with the revision it holds and a command id, then holds the new revision", async () => {
    const server = { doc: doc("1"), revision: 3 };
    const bed = await open(server);
    expect(await run((d) => addComment(d, comment("2")))).toBe(true);
    expect(bed.called("lanes.reviewState.set")[0]).toMatchObject({
      params: { laneId: "a-1a2b", baseRevision: 3 },
      options: { commandId: expect.any(String) },
    });
    expect(await run((d) => addComment(d, comment("3")))).toBe(true);
    expect(bed.called("lanes.reviewState.set")[1]?.params).toMatchObject({ baseRevision: 4 });
    expect(held().doc.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(server.doc.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("sends nothing when the change changes nothing", async () => {
    const bed = await open({ doc: doc("1"), revision: 1 });
    expect(await run((d) => d)).toBe(true);
    expect(bed.called("lanes.reviewState.set")).toHaveLength(0);
  });

  it("on a conflict reads again, applies the same change to what the server has, and retries once", async () => {
    const server = { doc: doc("1"), revision: 3 };
    const bed = await open(server);
    // Another device added comment 9 and deleted nothing, after this one read.
    server.doc = doc("1", "9");
    server.revision = 4;
    expect(await run((d) => addComment(d, comment("2")))).toBe(true);
    expect(bed.called("lanes.reviewState.get")).toHaveLength(2);
    expect(
      bed.called("lanes.reviewState.set").map((c) => (c.params as { baseRevision: number }).baseRevision),
    ).toEqual([3, 4]);
    expect(server.doc.comments.map((c) => c.id)).toEqual(["1", "9", "2"]);
    expect(held().doc.comments.map((c) => c.id)).toEqual(["1", "9", "2"]);
  });

  it("keeps a deletion made here after the merge", async () => {
    const server = { doc: doc("1", "2"), revision: 1 };
    await open(server);
    server.doc = doc("1", "2", "9");
    server.revision = 2;
    expect(await run((d) => deleteComment(d, "1"))).toBe(true);
    expect(server.doc.comments.map((c) => c.id)).toEqual(["2", "9"]);
  });

  it("gives up after the second conflict: it says so and shows what the server has", async () => {
    const server = { doc: doc("1"), revision: 1 };
    await open(server, () => {
      server.doc = doc("1", "z");
      server.revision += 1;
      throw new RpcError("conflict");
    });
    expect(await run((d) => addComment(d, comment("2")))).toBe(false);
    expect(held().error).toBe("conflict");
    expect(held().doc.comments.map((c) => c.id)).toEqual(["1", "z"]);
  });

  it("after a failure with an unknown outcome, shows what the server has", async () => {
    const server = { doc: doc("1"), revision: 1 };
    await open(server, () => {
      throw new RpcError("timeout");
    });
    expect(await run((d) => addComment(d, comment("2")))).toBe(false);
    expect(held().error).toBe("timeout");
    expect(held().doc.comments.map((c) => c.id)).toEqual(["1"]);
  });

  it("runs two changes one after the other, never with the same revision", async () => {
    const server = { doc: doc(), revision: 0 };
    const bed = await open(server);
    await act(async () => {
      await Promise.all([
        held().update((d) => addComment(d, comment("1"))),
        held().update((d) => addComment(d, comment("2"))),
      ]);
    });
    expect(
      bed.called("lanes.reviewState.set").map((c) => (c.params as { baseRevision: number }).baseRevision),
    ).toEqual([0, 1]);
    expect(server.doc.comments.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("says when the document cannot be read, and reads again on reload", async () => {
    const bed = newBed();
    let fail = true;
    bed.handlers["lanes.reviewState.get"] = () => {
      if (fail) throw new RpcError("not_found");
      return { doc: doc("1"), revision: 1 };
    };
    await mount(<Probe />);
    await settle();
    expect(held().status).toBe("error");
    expect(held().error).toBe("not_found");
    fail = false;
    await act(async () => held().reload());
    await settle();
    expect(held().status).toBe("ready");
  });
});
