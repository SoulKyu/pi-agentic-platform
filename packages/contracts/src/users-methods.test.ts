import { describe, expect, it } from "vitest";
import { ERROR_CODES, methods, METHOD_IDEMPOTENT, USERS_BROWSER_ONLY, usersMethods } from "./index.ts";
import { InviteAcceptBody, InviteInfoBody, INVITE_INVALID, USERNAME_TAKEN } from "./invite.ts";

const TOKEN = "a".repeat(43);

describe("users methods", () => {
  it("are all browser-only", () => {
    expect([...USERS_BROWSER_ONLY].sort()).toEqual(Object.keys(usersMethods).sort());
    for (const name of Object.keys(usersMethods)) expect(name.startsWith("users.")).toBe(true);
  });

  it("declares the permissions", () => {
    expect(usersMethods["users.list"].permission).toBe("users:read");
    expect(usersMethods["users.providers"].permission).toBe("users:read");
    for (const name of ["invite", "revokeInvite", "setBudget", "setDisabled", "delete", "setProviderShared"])
      expect(methods[`users.${name}` as keyof typeof methods].permission, name).toBe("users:admin");
  });

  it("declares the step-ups and the secret result", () => {
    for (const name of ["users.delete", "users.invite", "users.setDisabled"] as const)
      expect(usersMethods[name].errors, name).toContain("step_up_required");
    expect(usersMethods["users.invite"].secretResult).toBe(true);
    expect(usersMethods["users.invite"].idempotent).toBe(false);
  });

  it("declares only real error codes, and is in the idempotent table", () => {
    for (const def of Object.values(usersMethods)) {
      for (const code of def.errors) expect(ERROR_CODES).toContain(code);
      expect(METHOD_IDEMPOTENT[def.name]).toBe(def.idempotent);
    }
  });

  it("bounds the budget and the name hint", () => {
    const { params } = usersMethods["users.setBudget"];
    expect(params.safeParse({ userId: "u", dailyBudgetUsd: 1000 }).success).toBe(true);
    expect(params.safeParse({ userId: "u", dailyBudgetUsd: 1001 }).success).toBe(false);
    expect(params.safeParse({ userId: "u", dailyBudgetUsd: -1 }).success).toBe(false);
    expect(usersMethods["users.invite"].params.safeParse({ nameHint: "" }).success).toBe(false);
    expect(usersMethods["users.invite"].params.safeParse({}).success).toBe(true);
  });

  it("declares the invitation bodies and codes", () => {
    expect(INVITE_INVALID).toBe("invite_invalid");
    expect(USERNAME_TAKEN).toBe("username_taken");
    expect(InviteInfoBody.safeParse({ token: TOKEN }).success).toBe(true);
    expect(
      InviteAcceptBody.safeParse({ token: TOKEN, username: "bad name", password: "x".repeat(12) }).success,
    ).toBe(false);
    expect(InviteAcceptBody.safeParse({ token: TOKEN, username: "ann_1", password: "short" }).success).toBe(
      false,
    );
    expect(
      InviteAcceptBody.safeParse({ token: TOKEN, username: "ann_1", password: "x".repeat(12) }).success,
    ).toBe(true);
  });
});

describe("M14 permission moves", () => {
  it("moves the GitHub App, the Claude token, the ops feed and fonts", () => {
    expect(methods["github.startCreate"].permission).toBe("system:admin");
    expect(methods["github.forget"].permission).toBe("system:admin");
    expect(methods["github.authorizeUrl"].permission).toBe("settings:operate");
    expect(methods["github.disconnect"].permission).toBe("settings:operate");
    expect(methods["agents.vm.setClaudeToken"].permission).toBe("settings:operate");
    expect(methods["agents.vm.clearClaudeToken"].permission).toBe("settings:operate");
    expect(methods["ops.events.list"].permission).toBe("system:read");
    expect(methods["subscribe.ops"].permission).toBe("system:read");
    expect(methods["fonts.add"].permission).toBe("system:admin");
    expect(methods["fonts.remove"].permission).toBe("system:admin");
  });

  it("adds agents.packages and sessions.availableModels", () => {
    expect(methods["agents.packages"]).toMatchObject({ permission: "agents:read", idempotent: true });
    expect(methods["sessions.availableModels"]).toMatchObject({
      permission: "sessions:read",
      idempotent: true,
    });
    expect(methods["sessions.availableModels"].params.safeParse({ cwd: "/x" }).success).toBe(false);
  });
});
