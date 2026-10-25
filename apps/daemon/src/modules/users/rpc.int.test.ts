import type { HandlerContext, HandlerTable } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";
import { testCaller } from "../../testing/caller.ts";
import { requireStepUp } from "../auth/index.ts";
import { call as http, cookieOf, ownerCookie, startDaemon, type Daemon } from "../auth/testing/ceremony.ts";
import { createAuthTestBed, PASSWORD, type AuthTestBed } from "../auth/testing/fixture.ts";
import { usersAdminRpc } from "./rpc.ts";
import { createUsersService } from "./service.ts";

const ORIGIN = "http://localhost:7777";
const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");

let bed: AuthTestBed;
let daemon: Daemon;
let ownerId: string;
let stopAll: Mock<() => Promise<void>>;
let refresh: Mock<() => void>;
let call: (method: string, params: unknown, stepUp?: boolean) => Promise<Record<string, unknown>>;
let command = 0;

beforeEach(async () => {
  bed = createAuthTestBed();
  daemon = startDaemon(bed, ORIGIN);
  await ownerCookie(daemon);
  ownerId = daemon.auth.ownerId() ?? "";
  stopAll = vi.fn(async () => undefined);
  refresh = vi.fn();
  const service = createUsersService({
    clock: bed.clock,
    audit: { append: (line) => void bed.audited.push(line) },
    auth: daemon.auth,
    requireStepUp,
    capOf: (id) => daemon.auth.budgetOf(id),
    usage: { spentToday: () => 0, spentSince: () => 0, boxesRunning: () => 0 },
    disabling: { stopAll },
    cascade: { run: async (id) => daemon.auth.deleteUser(id) },
    refreshPolicies: refresh,
  });
  const dispatch = createDispatcher({
    gate: NO_CLIENT_PATHS,
    handlers: usersAdminRpc(service) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  call = async (method, params, stepUp = false) => {
    const ctx: HandlerContext = {
      caller: testCaller({ userId: ownerId, stepUpUntil: stepUp ? bed.clock.now() + 60_000 : 0 }),
      connectionId: "c1",
      origin: ORIGIN,
      openSubscription: () => "s1",
      closeSubscription: () => {},
    };
    command++;
    return (await dispatch({ id: command, method, params, commandId: `cmd-${command}-0001` }, ctx)) as never;
  };
});
afterEach(() => bed.dispose());

const everything = () =>
  JSON.stringify([
    bed.db.all("SELECT * FROM receipts"),
    bed.db.all("SELECT * FROM invitations"),
    bed.audited,
    bed.lines,
  ]);
const errorOf = (answer: Record<string, unknown>) => (answer.error as { code?: string } | undefined)?.code;

async function memberCookie(name: string): Promise<{ id: string; cookie: string }> {
  const answer = await call("users.invite", { nameHint: name }, true);
  const token = tokenOf((answer.result as { url: string }).url);
  const reply = await http(daemon, "/auth/invite/accept", { token, username: name, password: PASSWORD });
  expect(reply.status).toBe(204);
  const cookie = cookieOf(reply.setCookie);
  const id = daemon.auth.authenticateCookieHeader(cookie)?.userId ?? "";
  return { id, cookie };
}

describe("users.* through the dispatcher", () => {
  it("users.invite leaves no token in receipts, the invitations table, the audit or the log", async () => {
    const answer = await call("users.invite", { nameHint: "Ana" }, true);
    expect(answer.ok).toBe(true);
    const { url, invite } = answer.result as { url: string; invite: { id: string } };
    const token = tokenOf(url);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(url.startsWith(`${ORIGIN}/invite#token=`)).toBe(true);
    expect(everything()).not.toContain(token);
    expect(bed.audited.find((line) => line.reason === "user_invited")?.detail).toEqual({
      inviteId: invite.id,
    });
    const listed = (await call("users.list", {})).result as { invites: Array<{ id: string }> };
    expect(listed.invites.map((entry) => entry.id)).toEqual([invite.id]);
  });

  it("users.invite and enabling a member need a step-up", async () => {
    expect(errorOf(await call("users.invite", {}))).toBe("step_up_required");
    const { id } = await memberCookie("mia");
    expect(errorOf(await call("users.setDisabled", { userId: id, disabled: true }))).toBeUndefined();
    expect(errorOf(await call("users.setDisabled", { userId: id, disabled: false }))).toBe(
      "step_up_required",
    );
    expect(daemon.auth.isDisabled(id)).toBe(true);
    expect((await call("users.setDisabled", { userId: id, disabled: false }, true)).ok).toBe(true);
    expect(daemon.auth.isDisabled(id)).toBe(false);
  });

  it("disable revokes the sessions, stops the machines and refreshes the relay; enable restores no credential (R5)", async () => {
    const member = await memberCookie("mia");
    expect(daemon.auth.authenticateCookieHeader(member.cookie)).not.toBeNull();
    expect((await call("users.setDisabled", { userId: member.id, disabled: true })).ok).toBe(true);
    expect(daemon.auth.authenticateCookieHeader(member.cookie)).toBeNull();
    expect(stopAll).toHaveBeenCalledWith(member.id);
    expect(refresh).toHaveBeenCalled();
    await call("users.setDisabled", { userId: member.id, disabled: false }, true);
    expect(daemon.auth.authenticateCookieHeader(member.cookie)).toBeNull();
    const signIn = await http(daemon, "/auth/login", { username: "mia", password: PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it("the owner cannot be disabled, and an unknown user is not found", async () => {
    expect(errorOf(await call("users.setDisabled", { userId: ownerId, disabled: true }))).toBe("forbidden");
    expect(errorOf(await call("users.setBudget", { userId: ownerId, dailyBudgetUsd: 1 }))).toBe("forbidden");
    expect(errorOf(await call("users.setDisabled", { userId: "ghost", disabled: true }))).toBe("not_found");
    expect(stopAll).not.toHaveBeenCalled();
  });

  it("audit rows are written for disable, enable, setBudget and revokeInvite, all to the owner", async () => {
    const member = await memberCookie("mia");
    await call("users.setBudget", { userId: member.id, dailyBudgetUsd: 9 });
    expect(daemon.auth.budgetOf(member.id)).toBe(9);
    await call("users.setDisabled", { userId: member.id, disabled: true });
    await call("users.setDisabled", { userId: member.id, disabled: false }, true);
    const made = (await call("users.invite", {}, true)).result as { invite: { id: string } };
    await call("users.revokeInvite", { inviteId: made.invite.id });
    expect(errorOf(await call("users.revokeInvite", { inviteId: made.invite.id }))).toBe("not_found");
    const rows = bed.audited.filter((line) =>
      ["budget_set", "user_disabled", "user_enabled", "invite_revoked", "member_created"].includes(
        line.reason,
      ),
    );
    expect(rows.map((line) => line.reason)).toEqual([
      "member_created",
      "budget_set",
      "user_disabled",
      "user_enabled",
      "invite_revoked",
    ]);
    expect(rows.every((line) => line.ownerId === ownerId)).toBe(true);
    expect(rows[2]?.detail).toEqual({ userId: member.id });
    expect(rows[0]?.detail).toMatchObject({ memberId: member.id });
  });

  it("users.delete asks the step-up, ends the member's sessions and tokens, removes the user and audits it without content", async () => {
    const member = await memberCookie("mia");
    expect(errorOf(await call("users.delete", { userId: member.id }))).toBe("step_up_required");
    expect(daemon.auth.roleOf(member.id)).toBe("member");
    expect((await call("users.delete", { userId: member.id }, true)).ok).toBe(true);
    expect(daemon.auth.roleOf(member.id)).toBeNull();
    expect(daemon.auth.authenticateCookieHeader(member.cookie)).toBeNull();
    expect(stopAll).toHaveBeenCalledWith(member.id);
    const deleted = bed.audited.find((line) => line.reason === "user_deleted");
    expect(deleted).toMatchObject({ ownerId, detail: { userId: member.id, username: "mia" } });
    expect(errorOf(await call("users.delete", { userId: ownerId }, true))).toBe("forbidden");
    expect(errorOf(await call("users.delete", { userId: "ghost" }, true))).toBe("not_found");
    expect(daemon.auth.roleOf(ownerId)).toBe("owner");
  });
});
