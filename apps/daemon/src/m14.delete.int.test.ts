import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./kernel/db/database.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { createSteppableClock, type SteppableClock } from "./security/testing/steppable-clock.ts";
import { ask, countOf as countIn, filesHolding, giveRows } from "./testing/member-rows.ts";
import { seedOwnerRows } from "./testing/seed-owner-rows.ts";
import { addMember, CANARY, codeOf, startTwoUsers, type TwoUsers } from "./testing/two-users.ts";

// M14 J1: deleting a member removes everything they own, with a real row, file or secret of each kind, and asks the step-up.

const ATTACHMENT = "ATTACHMENT-CANARY-dan-0123";
let clock: SteppableClock;
let u: TwoUsers;
beforeAll(async () => {
  clock = createSteppableClock();
  u = await startTwoUsers(undefined, {
    deps: { clock },
    config: { agentsMemoryMaxMb: 65_536, maxWorkers: 32 },
  });
}, 180_000);
afterAll(async () => u?.stop());
const countOf = (table: string, id: string): number => countIn(u.bed.t.home, table, id);

describe("deleting a member", () => {
  it("asks the step-up, then removes every row, file and secret they own except runs and audit, and leaves the owner's", async () => {
    const dan = await addMember(u.bed, "dan");
    const had = await giveRows(u, dan, false);
    // One of each thing a member owns: vault entries (user and agent scope), an attachment on disk, push subscriptions and
    // deliveries, an Inbox item, a settings row; their token, receipts and search rows came with the use above.
    await ask(dan, "automation.triggers.create", {
      input: TriggerInput.parse({
        name: "Manual",
        source: { type: "manual" },
        execution: { cwd: had.project.root, tools: ["read"] },
        prompt: "x",
      }),
    });
    await ask(dan, "agents.vm.setClaudeToken", { token: "sk-ant-oat01-DAN-0123456789-journey" });
    await ask(dan, "secrets.set", {
      agentId: had.agentId,
      name: "DAN_SECRET",
      value: "dan-secret-value-0123",
    });
    const upload = await dan.http(`/upload?name=a.txt&sessionId=${had.sessionId}`, {
      method: "POST",
      headers: { "content-length": String(ATTACHMENT.length) },
      body: ATTACHMENT,
    });
    expect(upload.status).toBe(201);
    const stateDb = openDatabase(join(u.bed.t.home, "state.db"));
    stateDb.exec("PRAGMA busy_timeout = 5000");
    const seeded = seedOwnerRows(stateDb, [dan.id], ["push_subs", "push_events", "inbox_items", "settings"]);
    stateDb.close();
    expect(seeded.get(dan.id)).toEqual(
      expect.arrayContaining(["push_subs", "push_events", "push_deliveries", "inbox_items", "settings"]),
    );
    const searchRows = (): number => {
      const index = new DatabaseSync(join(u.bed.t.home, "search.db"), { readOnly: true });
      try {
        return (
          index.prepare("SELECT count(*) AS n FROM rows WHERE owner_id = ?").get(dan.id) as { n: number }
        ).n;
      } finally {
        index.close();
      }
    };
    await vi.waitFor(() => expect(searchRows()).toBeGreaterThan(0), { timeout: 30_000 });
    const vaultDir = join(u.bed.t.home, "secrets", "vault", dan.id);
    const attachments = (): string[] => filesHolding(join(u.bed.t.home, "attachments"), ATTACHMENT);
    const owned = {
      vault: () => (existsSync(vaultDir) ? readdirSync(vaultDir).length : 0),
      attachments: () => attachments().length,
      search: searchRows,
      pushSubs: () => countOf("push_subs", dan.id),
      pushEvents: () => countOf("push_events", dan.id),
      inbox: () => countOf("inbox_items", dan.id),
      tokens: () => countOf("api_tokens", dan.id),
      receipts: () => countOf("receipts", dan.id),
      settings: () => countOf("settings", dan.id),
      triggers: () => countOf("triggers", dan.id),
      sessions: () => countOf("sessions", dan.id),
      deliveries: () =>
        rows<{ n: number }>(
          u.bed.t.home,
          "SELECT count(*) AS n FROM push_deliveries WHERE sub_id IN (SELECT id FROM push_subs WHERE owner_id = ?)",
          dan.id,
        )[0]?.n ?? 0,
    };
    for (const [name, count] of Object.entries(owned)) expect(count(), `${name} before`).toBeGreaterThan(0);
    expect(readdirSync(vaultDir).length).toBeGreaterThanOrEqual(2); // user scope and agent scope
    const kept = { runs: countOf("runs", dan.id), audit: countOf("audit", dan.id) };
    expect(kept.runs).toBeGreaterThan(0);
    expect(kept.audit).toBeGreaterThan(0);
    const everyOwnerTable = rows<{ name: string }>(
      u.bed.t.home,
      "SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND (EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'owner_id') OR EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'user_id'))",
    ).map((row) => row.name);

    // An hour passes: the owner's last confirmation has lapsed, and the delete asks for it again, before touching anything.
    await clock.advance(60 * 60_000);
    const refused = await u.owner.call("users.delete", { userId: dan.id });
    expect(codeOf(refused)).toBe("step_up_required");
    expect(owned.sessions()).toBeGreaterThan(0);
    expect(
      rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM users WHERE id = ?", dan.id)[0]?.n,
    ).toBe(1);
    await u.bed.t.confirmStepUp(u.owner.cookie);
    expect(codeOf(await u.owner.call("users.delete", { userId: dan.id }))).toBe("ok");

    for (const [name, count] of Object.entries(owned)) expect(count(), `${name} after`).toBe(0);
    expect(existsSync(vaultDir)).toBe(false);
    expect(
      everyOwnerTable.filter((table) => !["runs", "audit"].includes(table) && countOf(table, dan.id) > 0),
    ).toEqual([]);
    expect(countOf("runs", dan.id)).toBe(kept.runs);
    expect(countOf("audit", dan.id)).toBeGreaterThanOrEqual(kept.audit); // the delete itself adds rows
    expect(
      rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM users WHERE id = ?", dan.id)[0]?.n,
    ).toBe(0);
    expect(
      rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM audit WHERE reason = 'user_deleted'")[0]
        ?.n,
    ).toBe(1);
    expect(u.bed.vms.stopped.map((stopped) => stopped.agentId)).toContain(had.agentId);
    await expect(u.bed.t.connect(dan.cookie)).rejects.toThrow();
    // The owner and the other member keep theirs.
    expect(JSON.stringify(await u.owner.call("sessions.list", {}))).toContain(CANARY.session);
    expect(countOf("triggers", u.owner.id)).toBeGreaterThan(0);
    expect((await u.member.call("sessions.list", {})).ok).toBe(true);
  }, 240_000);
});
