import { PapError, type Caller } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { AuthUserRow } from "../auth/index.ts";
import { createUsersService, MAX_PENDING_INVITES, type UsersDeps } from "./service.ts";

const clock = createFakeClock(1_000_000_000);
const caller = (stepUpUntil = 0): Caller => ({
  userId: "o1",
  permissions: new Set(),
  kind: "session",
  credentialId: "c",
  stepUpUntil,
});
const stepped = () => caller(clock.now() + 60_000);
const refusesStepUp: UsersDeps["requireStepUp"] = (who, now) => {
  if (who.stepUpUntil <= now) throw new PapError("step_up_required");
};
const row = (over: Partial<AuthUserRow> & Pick<AuthUserRow, "id">): AuthUserRow => ({
  username: over.id,
  role: "member",
  createdAt: 1,
  lastSeenAt: null,
  disabledAt: null,
  budgetUsd: 5,
  ...over,
});

function build(
  users: AuthUserRow[] = [row({ id: "o1", role: "owner", budgetUsd: null }), row({ id: "m1" })],
) {
  const audit = { append: vi.fn() };
  const pending: Array<{
    id: string;
    createdBy: string;
    nameHint: string | null;
    createdAt: number;
    expiresAt: number;
  }> = [];
  const auth = {
    roleOf: (id: string) => users.find((user) => user.id === id)?.role ?? null,
    users: () => users,
    setBudget: vi.fn(),
    setDisabled: vi.fn(),
    invites: {
      create: vi.fn((createdBy: string, nameHint: string | null) => {
        const invite = { id: `i${pending.length + 1}`, createdBy, nameHint, createdAt: 1, expiresAt: 2 };
        pending.push(invite);
        return { url: "https://pap.example/invite#token=SECRET", expiresAt: 2, invite };
      }),
      pending: () => pending,
      revoke: vi.fn((id: string) => pending.some((invite) => invite.id === id)),
    },
  };
  const stopAll = vi.fn(async () => undefined);
  const refreshPolicies = vi.fn();
  const service = createUsersService({
    clock,
    audit,
    auth,
    requireStepUp: refusesStepUp,
    capOf: (id) => (id === "m1" ? 5 : null),
    usage: {
      spentToday: (id) => (id === "m1" ? 1.5 : 0.25),
      spentSince: (id) => (id === "m1" ? 4 : 2),
      boxesRunning: (id) => (id === "m1" ? 2 : 0),
    },
    disabling: { stopAll },
    cascade: { run: async () => undefined },
    refreshPolicies,
  });
  return { service, audit, auth, stopAll, refreshPolicies, pending };
}

describe("users service", () => {
  it("the owner cannot be disabled", async () => {
    const t = build();
    await expect(t.service.setDisabled(stepped(), "o1", true)).rejects.toMatchObject({ code: "forbidden" });
    expect(t.auth.setDisabled).not.toHaveBeenCalled();
    expect(t.stopAll).not.toHaveBeenCalled();
  });

  it("the owner has no cap to set, and an unknown id is not found", () => {
    const t = build();
    expect(() => t.service.setBudget(caller(), "o1", 3)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => t.service.setBudget(caller(), "ghost", 3)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("users.invite and enabling a member need a step-up; disabling does not", async () => {
    const t = build();
    expect(() => t.service.invite(caller(), null, "https://pap.example")).toThrow(
      expect.objectContaining({ code: "step_up_required" }),
    );
    await expect(t.service.setDisabled(caller(), "m1", false)).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(t.auth.setDisabled).not.toHaveBeenCalled();
    await t.service.setDisabled(caller(), "m1", true);
    expect(t.auth.setDisabled).toHaveBeenCalledWith("m1", true);
    t.service.invite(stepped(), "Ana", "https://pap.example");
    await t.service.setDisabled(stepped(), "m1", false);
    expect(t.auth.setDisabled).toHaveBeenLastCalledWith("m1", false);
  });

  it("disable revokes first, tells the relay, then stops the machines", async () => {
    const t = build();
    const order: string[] = [];
    t.auth.setDisabled.mockImplementation(() => void order.push("revoke"));
    t.refreshPolicies.mockImplementation(() => void order.push("refresh"));
    t.stopAll.mockImplementation(async () => void order.push("stop"));
    await t.service.setDisabled(caller(), "m1", true);
    expect(order).toEqual(["revoke", "refresh", "stop"]);
    order.length = 0;
    await t.service.setDisabled(stepped(), "m1", false);
    expect(order).toEqual(["revoke", "refresh"]);
  });

  it("writes an audit row for disable, enable, setBudget and revokeInvite, with no secret", async () => {
    const t = build();
    await t.service.setDisabled(caller(), "m1", true);
    await t.service.setDisabled(stepped(), "m1", false);
    t.service.setBudget(caller(), "m1", 7);
    const made = t.service.invite(stepped(), null, "https://pap.example");
    t.service.revokeInvite(caller(), made.invite.id);
    const lines = t.audit.append.mock.calls.map(([line]) => line);
    expect(lines.map((line) => line.reason)).toEqual([
      "user_disabled",
      "user_enabled",
      "budget_set",
      "invite_revoked",
    ]);
    expect(lines.every((line) => line.ownerId === "o1" && line.kind === "auth")).toBe(true);
    expect(lines[0].detail).toEqual({ userId: "m1" });
    expect(lines[2].detail).toEqual({ userId: "m1", dailyBudgetUsd: 7 });
    expect(JSON.stringify(lines)).not.toContain("SECRET");
  });

  it("revoking an invitation nothing holds is not found and writes nothing", () => {
    const t = build();
    expect(() => t.service.revokeInvite(caller(), "nope")).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(t.audit.append).not.toHaveBeenCalled();
  });

  it("refuses an invitation past the pending limit", () => {
    const t = build();
    for (let n = 0; n < MAX_PENDING_INVITES; n++) t.service.invite(stepped(), null, "https://pap.example");
    expect(() => t.service.invite(stepped(), null, "https://pap.example")).toThrow(
      expect.objectContaining({ code: "limit_reached" }),
    );
  });

  it("the invite answer carries the link and an invite without its creator", () => {
    const t = build();
    const made = t.service.invite(stepped(), "Ana", "https://pap.example");
    expect(made.url).toContain("#token=");
    expect(made.invite).toEqual({ id: "i1", nameHint: "Ana", createdAt: 1, expiresAt: 2 });
  });

  it("list shows usage, never content", () => {
    const t = build([
      row({ id: "o1", role: "owner", budgetUsd: null }),
      row({ id: "m1", disabledAt: 5, lastSeenAt: 9 }),
    ]);
    t.service.invite(stepped(), "Ana", "https://pap.example");
    const listed = t.service.list();
    expect(listed.users).toEqual([
      expect.objectContaining({
        id: "o1",
        role: "owner",
        budgetUsd: null,
        spentTodayUsd: 0.25,
        spent7dUsd: 2,
        boxesRunning: 0,
        disabled: false,
      }),
      expect.objectContaining({
        id: "m1",
        budgetUsd: 5,
        spentTodayUsd: 1.5,
        spent7dUsd: 4,
        boxesRunning: 2,
        disabled: true,
        lastSeenAt: 9,
      }),
    ]);
    expect(Object.keys(listed.users[1] ?? {}).sort()).toEqual(
      [
        "boxesRunning",
        "budgetUsd",
        "createdAt",
        "disabled",
        "id",
        "lastSeenAt",
        "role",
        "spent7dUsd",
        "spentTodayUsd",
        "username",
      ].sort(),
    );
    expect(listed.invites).toEqual([{ id: "i1", nameHint: "Ana", createdAt: 1, expiresAt: 2 }]);
  });
});
