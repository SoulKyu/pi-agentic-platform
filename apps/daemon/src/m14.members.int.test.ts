import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AutomationSettings, type ProjectView, TriggerInput } from "@pap/contracts";
import { vi } from "vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "./security/testing/automation-bed.ts";
import { httpRequest } from "./testing/http-client.ts";
import { addMember, MEMBER_PASSWORD, startTwoUsers, type TwoUsers, writeDb } from "./testing/two-users.ts";
import { codeOf } from "./testing/two-users.ts";

// M14 J1: the invitation, what a member never gets (a host project, terminal, lane or trigger), the scanner and the audit.

let u: TwoUsers;
beforeAll(
  async () =>
    void (u = await startTwoUsers(undefined, {
      agentFiles: {
        "models.json": JSON.stringify({
          providers: {
            acme: {
              baseUrl: "http://127.0.0.1:9",
              apiKey: "literal-key",
              api: "openai-completions",
              models: [{ id: "m-1" }],
            },
          },
        }),
      },
    })),
  180_000,
);
afterAll(async () => u?.stop());

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  httpRequest(`${u.bed.t.base}${path}`, {
    method: "POST",
    headers: { origin: u.bed.t.origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const cookieOf = (reply: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = reply.headers["set-cookie"];
  return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
};
const tokenOf = (url: string): string => new URL(url).hash.replace("#token=", "");

describe("an invitation", () => {
  it("makes a member who signs in, sees the member role and gets no owner feature", async () => {
    const invited = await u.owner.call("users.invite", { nameHint: "Noa" });
    expect(invited.ok).toBe(true);
    const { url } = (invited.ok ? invited.result : { url: "" }) as { url: string };
    const token = tokenOf(url);
    expect(url).toBe(`${u.bed.t.origin}/invite#token=${token}`);

    const info = await post("/auth/invite/info", { token });
    expect(JSON.parse(info.body)).toMatchObject({ inviter: u.owner.name });
    const accepted = await post("/auth/invite/accept", { token, username: "noa", password: MEMBER_PASSWORD });
    expect(accepted.status).toBe(204);
    const reuse = await post("/auth/invite/accept", { token, username: "noa2", password: MEMBER_PASSWORD });
    expect(reuse.status).toBe(404);
    expect(JSON.parse(reuse.body)).toEqual({ error: { code: "invite_invalid" } });

    // Sign out and in again with the password: the member role rides on /auth/status.
    const login = await post("/auth/login", { username: "noa", password: MEMBER_PASSWORD });
    expect(login.status).toBe(200);
    const status = await httpRequest(`${u.bed.t.base}/auth/status`, { headers: { cookie: cookieOf(login) } });
    expect(JSON.parse(status.body)).toMatchObject({ authenticated: true, role: "member" });
    const ownerStatus = await httpRequest(`${u.bed.t.base}/auth/status`, {
      headers: { cookie: u.owner.cookie },
    });
    expect(JSON.parse(ownerStatus.body)).toMatchObject({ role: "owner" });

    // Over a socket: users:* is denied by the dispatcher, with the permission check before the params parse.
    const client = await u.bed.t.connect(cookieOf(login));
    try {
      for (const method of [
        "users.list",
        "users.invite",
        "users.setBudget",
        "users.delete",
        "users.providers",
      ] as const) {
        const frame = await client.call(method, {} as never);
        expect(frame.ok ? "ok" : frame.error.code, method).toBe("forbidden");
      }
      expect((await client.call("models.available", {})).ok).toBe(false);
      expect((await client.call("settings.get", { key: "appearance" })).ok).toBe(true);
    } finally {
      client.close();
    }
    const second = await u.owner.call("users.list", {});
    const names = (
      second.ok ? (second.result as { users: Array<{ username: string; role: string }> }).users : []
    ).map((user) => `${user.username}:${user.role}`);
    expect(names).toContain("noa:member");
    expect(names.filter((name) => name.endsWith(":owner"))).toHaveLength(1);
  });

  it("a revoked invitation does not work", async () => {
    const invited = await u.owner.call("users.invite", { nameHint: "Eli" });
    const result = (invited.ok ? invited.result : null) as { url: string; invite: { id: string } };
    expect((await u.owner.call("users.revokeInvite", { inviteId: result.invite.id })).ok).toBe(true);
    const revoked = await post("/auth/invite/accept", {
      token: tokenOf(result.url),
      username: "eli",
      password: MEMBER_PASSWORD,
    });
    // A failed accept is counted and backs off: the second one in a row may be asked to wait (429), never accepted.
    expect([404, 429]).toContain(revoked.status);
    const listed = await u.owner.call("users.list", {});
    const state = (listed.ok ? listed.result : null) as {
      users: Array<{ username: string }>;
      invites: Array<{ id: string }>;
    };
    expect(state.users.map((user) => user.username)).not.toContain("eli");
    expect(state.invites.map((invite) => invite.id)).not.toContain(result.invite.id);
  });
});

describe("what the web reads", () => {
  it("the automation settings carry the cap to a member and none to the owner; a write past it is budget_cap", async () => {
    const own = await u.member.call("settings.get", { key: "automation" });
    const value = (own.ok ? own.result : null) as {
      value: { dailyBudgetUsd: number | null; dailyBudgetCapUsd: number | null };
      revision: number;
    };
    expect(value.value).toMatchObject({ dailyBudgetCapUsd: 5, dailyBudgetUsd: 5 });
    const ownerView = await u.owner.call("settings.get", { key: "automation" });
    // Nothing stored for the owner: the web's schema fills in "no cap".
    const stored = (ownerView.ok ? (ownerView.result as { value: object | null }).value : null) ?? {};
    expect(AutomationSettings.parse(stored).dailyBudgetCapUsd).toBeNull();
    const raised = await u.member.call("settings.set", {
      key: "automation",
      value: AutomationSettings.parse({ ...value.value, dailyBudgetUsd: 50 }),
      baseRevision: value.revision,
    });
    expect(codeOf(raised)).toBe("budget_cap");
    const cleared = await u.member.call("settings.set", {
      key: "automation",
      value: AutomationSettings.parse({ ...value.value, dailyBudgetUsd: null }),
      baseRevision: value.revision,
    });
    expect(codeOf(cleared)).toBe("budget_cap");
  });
});

describe("a member never gets a host project, terminal, lane or trigger", () => {
  const host = () => u.bed.t.cwd;
  const code = async (method: string, params: object) =>
    codeOf(await u.member.call(method as never, params as never));

  it("a host folder is refused everywhere it could become a project, a shell, a session or a trigger's folder", async () => {
    expect(await code("projects.add", { root: host() })).toBe("forbidden");
    expect(await code("sessions.create", { cwd: host() })).toBe("forbidden");
    expect(
      await code("terminal.create", { requestId: "r".repeat(26), cwd: host(), cols: 80, rows: 24 }),
    ).toBe("forbidden");
    expect(await code("files.list", { path: host() })).toBe("forbidden");
    const trigger = {
      input: {
        name: "Host",
        source: { type: "manual" },
        execution: { cwd: host(), tools: ["read"] },
        prompt: "x",
      },
    };
    expect(await code("automation.triggers.create", trigger)).toBe("forbidden");
    expect(await code("lanes.create", {})).toBe("forbidden");
    expect(await code("lanes.runScript", {})).toBe("forbidden");
  });

  it("what a member does get is a box: a named project is a box project, a scratch one is too, and a trigger runs in it", async () => {
    const created = await u.member.call("projects.create", { name: "Garden" });
    expect(created.ok).toBe(true);
    const project = (created.ok ? (created.result as { project: ProjectView }).project : null) as ProjectView;
    expect(project.kind).toBe("box");
    const scratch = await u.member.call("projects.scratch", {});
    if (scratch.ok) expect((scratch.result as { project: ProjectView }).project.kind).toBe("box");
    const own = await u.member.call("automation.triggers.create", {
      input: TriggerInput.parse({
        name: "Mine",
        source: { type: "manual" },
        execution: { cwd: project.root, tools: ["read"] },
        prompt: "x",
      }),
    });
    expect(own.ok, JSON.stringify(own)).toBe(true);
    const listed = await u.member.call("automation.triggers.list", {});
    const names = (listed.ok ? (listed.result as { triggers: Array<{ name: string }> }).triggers : []).map(
      (t) => t.name,
    );
    expect(names).toEqual(["Mine"]);
  });
});

describe("the Pi session scanner", () => {
  it("adopts a session file to the owner only, never to a member", async () => {
    // The owner is made the YOUNGEST user, so "the first row" and "the owner" are different people: the scanner's owner
    // follows `role = 'owner'`, never the creation order.
    writeDb(u.bed.t.home, "UPDATE users SET created_at = created_at + 100000000 WHERE role = 'owner'");
    const created = rows<{ id: string; role: string }>(
      u.bed.t.home,
      "SELECT id, role FROM users ORDER BY created_at, id",
    );
    expect(created[0]?.role).toBe("member");
    expect(created.at(-1)).toMatchObject({ id: u.owner.id, role: "owner" });
    vi.stubEnv("PI_CODING_AGENT_DIR", join(u.bed.t.root, "agent"));
    try {
      expect((await u.owner.call("subscribe.shell", {})).ok).toBe(true);
      await u.owner.client.waitForEvent(
        (frame) => (frame.event as { kind?: string }).kind === "snapshot",
        10_000,
      );
      const folder = join(
        u.bed.t.root,
        "agent",
        "sessions",
        `--${u.bed.t.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      );
      mkdirSync(folder, { recursive: true });
      const manager = SessionManager.create(u.bed.t.cwd, folder);
      manager.appendMessage({ role: "user", content: "hello from the pi cli", timestamp: Date.now() });
      manager.getSessionId();
      let adoptedId = "";
      await vi.waitFor(
        async () => {
          const listed = await u.owner.call("sessions.list", {});
          const sessions = listed.ok
            ? (listed.result as { sessions: Array<{ id: string; cwd: string }> }).sessions
            : [];
          adoptedId = sessions.find((session) => session.cwd === u.bed.t.cwd)?.id ?? "";
          expect(adoptedId).not.toBe("");
        },
        { timeout: 40_000, interval: 500 },
      );
      const [row] = rows<{ owner_id: string }>(
        u.bed.t.home,
        "SELECT owner_id FROM sessions WHERE id = ?",
        adoptedId,
      );
      expect(row?.owner_id).toBe(u.owner.id);
      expect(row?.owner_id).not.toBe(created[0]?.id);
      expect(JSON.stringify(await u.member.call("sessions.list", {}))).not.toContain(adoptedId);
      expect(JSON.stringify(await u.owner.call("sessions.list", {}))).toContain(adoptedId);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
});

describe("the owner's audit", () => {
  it("install-level actions write rows to the owner: invite, create, budget, disable, enable, sharing, revoke", async () => {
    const invited = await u.owner.call("users.invite", { nameHint: "Ana" });
    const made = (invited.ok ? invited.result : null) as { url: string; invite: { id: string } };
    await u.owner.call("users.revokeInvite", { inviteId: made.invite.id });
    const target = (await addMember(u.bed, "bea")).id;
    expect((await u.owner.call("users.setBudget", { userId: target, dailyBudgetUsd: 7 })).ok).toBe(true);
    expect((await u.owner.call("users.setDisabled", { userId: target, disabled: true })).ok).toBe(true);
    expect((await u.owner.call("users.setDisabled", { userId: target, disabled: false })).ok).toBe(true);
    const providers = await u.owner.call("users.providers", {});
    const first = (
      providers.ok ? (providers.result as { providers: Array<{ provider: string }> }).providers : []
    )[0];
    expect(first?.provider).toBe("acme");
    expect((await u.owner.call("users.setProviderShared", { provider: "acme", shared: false })).ok).toBe(
      true,
    );
    const audited = rows<{ reason: string; owner_id: string }>(
      u.bed.t.home,
      "SELECT reason, owner_id FROM audit WHERE reason IN ('user_invited','member_created','budget_set','user_disabled','user_enabled','invite_revoked','provider_sharing_set') ORDER BY id",
    );
    const reasons = new Set(audited.map((row) => row.reason));
    for (const reason of [
      "user_invited",
      "member_created",
      "budget_set",
      "user_disabled",
      "user_enabled",
      "invite_revoked",
    ])
      expect(reasons.has(reason), reason).toBe(true);
    expect(reasons.has("provider_sharing_set")).toBe(true);
    expect(audited.every((row) => row.owner_id === u.owner.id)).toBe(true);
    // A member's own call to the same actions leaves nothing: it is refused first.
    expect(codeOf(await u.member.call("users.setBudget", { userId: target, dailyBudgetUsd: 1000 }))).toBe(
      "forbidden",
    );
    expect(
      rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM audit WHERE reason = 'budget_set'")[0]?.n,
    ).toBe(1);
  });
});
