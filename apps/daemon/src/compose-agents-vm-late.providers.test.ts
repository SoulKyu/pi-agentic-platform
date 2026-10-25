import { describe, expect, it } from "vitest";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";

const MEMBER_PROJECT = "7a2d3a1f-9a6c-4c64-8b63-1e3a5b5d8e22";
const models = [
  { provider: "shared", id: "m-1" },
  { provider: "private", id: "m-2" },
  { provider: "claude-bridge", id: "sonnet" },
];
/** The owner sees every provider; a member only the ones `shared` lists. */
const gate = (shared: readonly string[]) => ({
  filter: async <T extends { provider: string }>(userId: string, items: readonly T[]) =>
    items.filter((item) => userId === "owner1" || shared.includes(item.provider)),
  reset: () => {},
});
const bed = (shared: readonly string[]) =>
  lateWithBoxes({
    models,
    rows: {
      [PROJECT]: boxRow({ ownerId: "owner1" }),
      [MEMBER_PROJECT]: boxRow({ ownerId: "member1", root: `/boxes/${MEMBER_PROJECT}` }),
    },
    providers: gate(shared),
  }).derived;

describe("shared providers in a box's policy (M14)", () => {
  it("drops the providers the owner did not share from a member's models, never from the owner's", async () => {
    const derived = bed(["shared"]);
    expect((await derived.policyOfProject(MEMBER_PROJECT)).models).toEqual([
      { provider: "shared", id: "m-1" },
    ]);
    expect((await derived.policyOfProject(PROJECT)).models).toEqual([
      { provider: "shared", id: "m-1" },
      { provider: "private", id: "m-2" },
    ]);
  });
  it("applies a change of sharing at once, even when the helper's list is kept", async () => {
    const shared = ["shared"];
    const derived = bed(shared);
    expect((await derived.policyOfProject(MEMBER_PROJECT)).models).toHaveLength(1);
    shared.push("private");
    expect((await derived.policyOfProject(MEMBER_PROJECT)).models).toHaveLength(2);
  });
});
