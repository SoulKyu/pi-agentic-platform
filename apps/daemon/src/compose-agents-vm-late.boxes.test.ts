import { describe, expect, it } from "vitest";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";

describe("a project box's host list (the proxy reads it on every connection)", () => {
  it("is the owner's list and the project's together, each entry once", () => {
    const { derived } = lateWithBoxes({
      rows: { [PROJECT]: boxRow({ hosts: ["git.example.com", "registry.example.com:443"] }) },
      ownerHosts: () => ["registry.example.com:443", "docs.example.com"],
    });
    expect(derived.hostsOfProject(PROJECT)).toEqual([
      "registry.example.com:443",
      "docs.example.com",
      "git.example.com",
    ]);
  });
  it("is the project's alone when the owner has no list, and empty when neither has one", () => {
    expect(
      lateWithBoxes({
        rows: { [PROJECT]: boxRow({ hosts: ["git.example.com"] }) },
        ownerHosts: () => null,
      }).derived.hostsOfProject(PROJECT),
    ).toEqual(["git.example.com"]);
    expect(lateWithBoxes().derived.hostsOfProject(PROJECT)).toEqual([]);
  });
  it("is the owner of the project's list, never another owner's", () => {
    const asked: string[] = [];
    lateWithBoxes({
      rows: { [PROJECT]: boxRow({ ownerId: "u9" }) },
      ownerHosts: (owner) => (asked.push(owner), []),
    }).derived.hostsOfProject(PROJECT);
    expect(asked).toEqual(["u9"]);
  });
  it("is null for an unknown project and for one being deleted", () => {
    expect(lateWithBoxes({ rows: {} }).derived.hostsOfProject(PROJECT)).toBeNull();
    expect(
      lateWithBoxes({ rows: { [PROJECT]: boxRow({ deleting: true }) } }).derived.hostsOfProject(PROJECT),
    ).toBeNull();
  });
});

describe("a project box's relay policy", () => {
  it("gets the owner's models and is blocked over budget", async () => {
    const bed = lateWithBoxes({
      models: [
        { provider: "acme", id: "m-1" },
        { provider: "claude-bridge", id: "sonnet" },
      ],
      token: true,
    });
    expect(await bed.derived.policyOfProject(PROJECT)).toEqual({
      models: [{ provider: "acme", id: "m-1" }],
      claude: true,
      claudeToken: "tok-x",
      blocked: null,
    });
    const over = lateWithBoxes({ overBudget: (owner) => owner === "u1" });
    expect(await over.derived.policyOfProject(PROJECT)).toMatchObject({ blocked: "budget" });
    expect(over.ownerOverBudget).toHaveBeenCalledWith("u1");
  });
  it("is blocked paused for a disabled owner, then back to the owner's own line on enable (M14 RT-03)", async () => {
    const off = new Set(["u1"]);
    const memberLine = { over: () => true, disabled: (id: string) => off.has(id) };
    const bed = lateWithBoxes({ memberLine });
    expect(await bed.derived.policyOfProject(PROJECT)).toMatchObject({ blocked: "paused" });
    off.clear();
    expect(await bed.derived.policyOfProject(PROJECT)).toMatchObject({ blocked: "budget" });
  });
  it("names a disabled owner's boxes to the launch gate", () => {
    const off = new Set(["u1"]);
    const bed = lateWithBoxes({ memberLine: { over: () => false, disabled: (id) => off.has(id) } });
    expect(bed.derived.boxDisabled({ kind: "project", id: PROJECT })).toBe(true);
    expect(bed.derived.boxDisabled({ kind: "project", id: "unknown" })).toBe(false);
    off.clear();
    expect(bed.derived.boxDisabled({ kind: "project", id: PROJECT })).toBe(false);
  });
  it("has the bridge only when the owner's Claude token is set", async () => {
    expect(await lateWithBoxes({ token: false }).derived.policyOfProject(PROJECT)).toMatchObject({
      claude: false,
    });
  });
  it("a member's box gets the member's token or none, never the owner's (M14)", async () => {
    const MEMBER_PROJECT = "7a2d3a1f-9a6c-4c64-8b63-1e3a5b5d8e22";
    const bed = (tokens: Record<string, string>) =>
      lateWithBoxes({
        rows: {
          [PROJECT]: boxRow({ ownerId: "owner1" }),
          [MEMBER_PROJECT]: boxRow({ ownerId: "member1", root: `/boxes/${MEMBER_PROJECT}` }),
        },
        tokens,
      }).derived;
    const owner = bed({ owner1: "tok-owner" });
    expect(await owner.policyOfProject(PROJECT)).toMatchObject({ claude: true, claudeToken: "tok-owner" });
    // The owner has a token, the member has none: the member's box is told none.
    expect(await owner.policyOfProject(MEMBER_PROJECT)).toMatchObject({ claude: false, claudeToken: null });
    const both = bed({ owner1: "tok-owner", member1: "tok-member" });
    expect(await both.policyOfProject(MEMBER_PROJECT)).toMatchObject({
      claude: true,
      claudeToken: "tok-member",
    });
    expect(await both.policyOfProject(PROJECT)).toMatchObject({ claudeToken: "tok-owner" });
  });
  it("is nothing for an unknown project or one being deleted (the relay refuses every request)", async () => {
    const nothing = { models: [], claude: false, claudeToken: null, blocked: null };
    expect(await lateWithBoxes({ rows: {} }).derived.policyOfProject(PROJECT)).toEqual(nothing);
    expect(
      await lateWithBoxes({ rows: { [PROJECT]: boxRow({ deleting: true }) } }).derived.policyOfProject(
        PROJECT,
      ),
    ).toEqual(nothing);
  });
  it("keeps the last models when a read fails, like an agent's policy", async () => {
    const bed = lateWithBoxes();
    await bed.derived.policyOfProject(PROJECT);
    bed.available.mockRejectedValueOnce(new Error("busy"));
    expect((await bed.derived.policyOfProject(PROJECT)).models).toEqual([{ provider: "acme", id: "m-1" }]);
  });
});
