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
      blocked: null,
    });
    const over = lateWithBoxes({ overBudget: (owner) => owner === "u1" });
    expect(await over.derived.policyOfProject(PROJECT)).toMatchObject({ blocked: "budget" });
    expect(over.ownerOverBudget).toHaveBeenCalledWith("u1");
  });
  it("has the bridge only when the owner's Claude token is set", async () => {
    expect(await lateWithBoxes({ token: false }).derived.policyOfProject(PROJECT)).toMatchObject({
      claude: false,
    });
  });
  it("is nothing for an unknown project or one being deleted (the relay refuses every request)", async () => {
    const nothing = { models: [], claude: false, blocked: null };
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
