import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATION_SOURCES } from "./daemon.ts";
import { createFakeClock } from "./kernel/clock.ts";
import type { Db } from "./kernel/db/database.ts";
import { migrate } from "./kernel/db/migrate.ts";
import { silentLogger } from "./kernel/logger.ts";
import type { AuthUserRow } from "./modules/auth/index.ts";
import { forgetPushOwner } from "./modules/push/index.ts";
import { createDeleteCascade, createDisabling, createUsersService } from "./modules/users/index.ts";
import { seedOwnerRows } from "./testing/seed-owner-rows.ts";

const KEPT: ReadonlySet<string> = new Set(["runs", "audit"]);
const clock = createFakeClock(1_700_000_000_000);
const caller = (stepUpUntil: number): Caller => ({
  userId: "o1",
  permissions: new Set(),
  kind: "session",
  credentialId: "c",
  stepUpUntil,
});
const stepped = () => caller(clock.now() + 60_000);
const refusesStepUp: Parameters<typeof createUsersService>[0]["requireStepUp"] = (who, now) => {
  if (who.stepUpUntil <= now) throw new PapError("step_up_required");
};
const userRow = (over: Partial<AuthUserRow> & Pick<AuthUserRow, "id">): AuthUserRow => ({
  username: over.id,
  role: "member",
  createdAt: 1,
  lastSeenAt: null,
  disabledAt: null,
  budgetUsd: 5,
  ...over,
});

let dir: string;
let db: Db;
let log: string[];
let users: AuthUserRow[];
let fail: string | null;

/** A cascade over the real database and fake modules that record their order; `fail` makes one step throw. */
function build() {
  const step =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      log.push(name);
      if (fail === name) throw new PapError("command_failed");
      return result;
    };
  const cascade = createDeleteCascade({
    db,
    github: { releaseKeysOf: step("github.releaseKeys", [] as number[]) },
    projects: { removeAll: step("projects.removeAll", 1) },
    agents: { trashAll: step("agents.trashAll", 1) },
    automation: { removeAll: step("automation.removeAll", {}) },
    sessions: { removeAll: step("sessions.removeAll", {}) },
    push: {
      forgetOwner: (id) => {
        log.push("push.forgetOwner");
        forgetPushOwner(db, id);
      },
    },
    search: { dropOwner: () => void log.push("search.dropOwner") },
    vault: { dropOwner: () => void log.push("vault.dropOwner") },
    auth: {
      deleteUser: (id) => {
        log.push("auth.deleteUser");
        users = users.filter((row) => row.id !== id);
      },
    },
    logger: silentLogger,
  });
  const audit = { append: vi.fn() };
  const auth = {
    roleOf: (id: string) => users.find((row) => row.id === id)?.role ?? null,
    users: () => users,
    setBudget: vi.fn(),
    setDisabled: vi.fn((id: string, disabled: boolean) => {
      log.push(`auth.setDisabled:${String(disabled)}`);
      users = users.map((row) => (row.id === id ? { ...row, disabledAt: disabled ? 1 : null } : row));
    }),
    invites: { create: vi.fn(), pending: () => [], revoke: vi.fn() },
  };
  const service = createUsersService({
    clock,
    audit,
    auth: auth as unknown as Parameters<typeof createUsersService>[0]["auth"],
    requireStepUp: refusesStepUp,
    capOf: () => 5,
    usage: { spentToday: () => 0, spentSince: () => 0, boxesRunning: () => 0 },
    disabling: createDisabling({
      boxes: { ownerBoxes: () => ["p1"], stop: step("boxes.stop", undefined) },
      agents: { list: () => [{ id: "atlas-0001" }] },
      stopAgent: step("agents.stop", undefined),
      logger: silentLogger,
    }),
    cascade,
    refreshPolicies: () => void log.push("relay.refresh"),
  });
  return { service, audit, auth };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-user-delete-"));
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: MIGRATION_SOURCES,
    clock,
    logger: silentLogger,
  }).db;
  log = [];
  fail = null;
  users = [userRow({ id: "o1", role: "owner", budgetUsd: null }), userRow({ id: "m1" })];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tablesWithOwner = (): Array<{ table: string; columns: string[] }> =>
  db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map(({ name }) => ({
      table: name,
      columns: db
        .all<{ name: string }>("SELECT name FROM pragma_table_info($name)", { name })
        .map((column) => column.name)
        .filter((column) => column === "owner_id" || column === "user_id"),
    }))
    .filter((entry) => entry.columns.length > 0);

const rowsOf = (table: string, columns: string[], id: string): number =>
  db.get<{ n: number }>(
    `SELECT count(*) AS n FROM "${table}" WHERE ${columns.map((column) => `${column} = $id`).join(" OR ")}`,
    { id },
  )?.n ?? 0;

describe("users.delete (A5b)", () => {
  it("delete asks the step-up, trashes projects and agents, and leaves no row with the member's owner_id or user_id except runs and audit", async () => {
    const seeded = seedOwnerRows(db, ["m1", "o1"]);
    // Every table with an owner column took a row: a table a later milestone adds that a generic row cannot fill fails here.
    expect(seeded.get("m1")?.length).toBe(tablesWithOwner().length + 1);
    expect(seeded.get("m1")).toEqual(expect.arrayContaining(["receipts", "settings", "push_subs", "runs"]));
    const { service, audit } = build();

    await expect(service.delete(caller(0), "m1")).rejects.toMatchObject({ code: "step_up_required" });
    expect(log).toEqual([]);
    expect(users.find((row) => row.id === "m1")?.disabledAt).toBeNull();

    await service.delete(stepped(), "m1");

    expect(log).toContain("projects.removeAll");
    expect(log).toContain("agents.trashAll");
    expect(users.map((row) => row.id)).toEqual(["o1"]);
    for (const { table, columns } of tablesWithOwner()) {
      if (KEPT.has(table)) continue;
      expect(rowsOf(table, columns, "m1"), `${table} still holds the member`).toBe(0);
      // The owner's own rows are not touched.
      if (seeded.get("o1")?.includes(table)) expect(rowsOf(table, columns, "o1"), table).toBeGreaterThan(0);
    }
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "o1",
        reason: "user_deleted",
        detail: { userId: "m1", username: "m1" },
      }),
    );
  });

  it("delete keeps the member's runs and audit rows", async () => {
    seedOwnerRows(db, ["m1"]);
    const before = { runs: rowsOf("runs", ["owner_id"], "m1"), audit: rowsOf("audit", ["owner_id"], "m1") };
    expect(before.runs).toBeGreaterThan(0);
    expect(before.audit).toBeGreaterThan(0);
    await build().service.delete(stepped(), "m1");
    expect(rowsOf("runs", ["owner_id"], "m1")).toBe(before.runs);
    expect(rowsOf("audit", ["owner_id"], "m1")).toBe(before.audit);
  });

  it("delete removes the member's push subscriptions, events and deliveries and no one else's", async () => {
    seedOwnerRows(db, ["m1", "o1"]);
    const deliveries = (id: string) =>
      db.get<{ n: number }>(
        `SELECT count(*) AS n FROM push_deliveries
          WHERE sub_id IN (SELECT id FROM push_subs WHERE owner_id = $id)
             OR event_id IN (SELECT id FROM push_events WHERE owner_id = $id)`,
        { id },
      )?.n ?? 0;
    expect(deliveries("m1")).toBeGreaterThan(0);
    await build().service.delete(stepped(), "m1");
    expect(deliveries("m1")).toBe(0);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM push_deliveries")?.n).toBe(deliveries("o1"));
    expect(deliveries("o1")).toBeGreaterThan(0);
  });

  it("signing keys are released before the vault is dropped", async () => {
    await build().service.delete(stepped(), "m1");
    expect(log.indexOf("github.releaseKeys")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("github.releaseKeys")).toBeLessThan(log.indexOf("vault.dropOwner"));
    expect(log).toEqual([
      "auth.setDisabled:true",
      "relay.refresh",
      "boxes.stop",
      "agents.stop",
      "github.releaseKeys",
      "projects.removeAll",
      "automation.removeAll",
      "agents.trashAll",
      "sessions.removeAll",
      "push.forgetOwner",
      "search.dropOwner",
      "vault.dropOwner",
      "auth.deleteUser",
    ]);
  });

  it("a crash after step 1 leaves a disabled account, and the delete can be asked again", async () => {
    fail = "projects.removeAll";
    const { service, audit } = build();
    await expect(service.delete(stepped(), "m1")).rejects.toMatchObject({ code: "command_failed" });
    const left = users.find((row) => row.id === "m1");
    expect(left?.disabledAt).not.toBeNull();
    expect(log).not.toContain("vault.dropOwner");
    expect(log).not.toContain("auth.deleteUser");
    expect(audit.append).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "user_deleted" }));
    fail = null;
    await service.delete(stepped(), "m1");
    expect(users.map((row) => row.id)).toEqual(["o1"]);
  });

  it("a machine that does not stop keeps the account and everything else in place", async () => {
    fail = "boxes.stop";
    const { service } = build();
    await expect(service.delete(stepped(), "m1")).rejects.toMatchObject({ code: "internal" });
    expect(users.find((row) => row.id === "m1")?.disabledAt).not.toBeNull();
    expect(log).not.toContain("github.releaseKeys");
    expect(log).not.toContain("auth.deleteUser");
  });

  it("the owner cannot be deleted, and an unknown id is not found", async () => {
    const { service } = build();
    await expect(service.delete(stepped(), "o1")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.delete(stepped(), "ghost")).rejects.toMatchObject({ code: "not_found" });
    expect(log).toEqual([]);
    expect(users.find((row) => row.id === "o1")?.disabledAt).toBeNull();
  });
});
