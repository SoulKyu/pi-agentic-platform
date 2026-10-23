import { describe, expect, it } from "vitest";
import { AgentView, methods, TOKEN_PERMISSIONS } from "./index.ts";

const input = { name: "Atlas" };

describe("agents methods (M11R43)", () => {
  it("reads are agents:read and idempotent; the writes are agents:admin mutations", () => {
    for (const name of ["agents.list", "agents.get"] as const) {
      expect(methods[name].permission).toBe("agents:read");
      expect(methods[name].idempotent).toBe(true);
    }
    for (const name of ["agents.create", "agents.update", "agents.delete"] as const) {
      expect(methods[name].permission).toBe("agents:admin");
      expect(methods[name].idempotent).toBe(false);
    }
    expect(TOKEN_PERMISSIONS).toContain("agents:read");
    expect(TOKEN_PERMISSIONS).not.toContain("agents:admin");
  });

  it("declares the errors a caller handles", () => {
    expect(methods["agents.create"].errors).toEqual(
      expect.arrayContaining(["step_up_required", "limit_reached", "conflict", "bad_request", "read_only"]),
    );
    expect(methods["agents.update"].errors).toEqual(
      expect.arrayContaining(["step_up_required", "not_found", "conflict", "bad_request", "read_only"]),
    );
    expect(methods["agents.delete"].errors).toEqual(
      expect.arrayContaining([
        "step_up_required",
        "not_found",
        "session_busy",
        "command_failed",
        "read_only",
      ]),
    );
    expect(methods["agents.get"].errors).toContain("not_found");
  });

  it("decodes the input with its defaults and refuses unknown params", () => {
    expect(methods["agents.create"].params.parse({ input })).toMatchObject({
      input: { name: "Atlas", mode: "auto-accept-edits" },
    });
    expect(methods["agents.create"].params.safeParse({ input, extra: 1 }).success).toBe(false);
    expect(
      methods["agents.update"].params.safeParse({ agentId: "atlas-1a2b", baseRevision: 0, input }).success,
    ).toBe(false);
    expect(
      methods["agents.update"].params.safeParse({ agentId: "atlas-1a2b", baseRevision: 1, input }).success,
    ).toBe(true);
    expect(methods["agents.delete"].params.safeParse({ agentId: ".runs" }).success).toBe(false);
    expect(methods["agents.get"].params.safeParse({ agentId: "../x-1a2b" }).success).toBe(false);
  });

  it("an agent view carries a null input for an unreadable row", () => {
    const view = {
      id: "atlas-1a2b",
      name: "Atlas",
      input: null,
      state: "unreadable",
      threadSessionId: null,
      unread: 0,
      paused: true,
      quarantinedAt: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(AgentView.safeParse(view).success).toBe(true);
    expect(AgentView.safeParse({ ...view, state: "gone" }).success).toBe(false);
    expect(AgentView.safeParse({ ...view, ownerId: "u1" }).success).toBe(false);
  });

  it("answers a delete with where the home went", () => {
    expect(methods["agents.delete"].result.safeParse({ trashedAs: "atlas-1a2b-1700000000000" }).success).toBe(
      true,
    );
  });
});
