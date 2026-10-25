import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { type Db, openDatabase } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { AuthUserRow } from "../auth/index.ts";
import { createDeleteCascade } from "./delete.ts";
import { createDisabling } from "./disable.ts";
import { deleteOwnerRows, KEPT_TABLES } from "./owner-rows.ts";
import { createUsersService, type UsersDeps } from "./service.ts";

const clock = createFakeClock(1_700_000_000_000);
const caller = (stepUpUntil: number): Caller => ({
  userId: "o1",
  permissions: new Set(),
  kind: "session",
  credentialId: "c",
  stepUpUntil,
});
const stepped = () => caller(clock.now() + 60_000);
const row = (over: Partial<AuthUserRow> & Pick<AuthUserRow, "id">): AuthUserRow => ({
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

function build() {
  const step =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      log.push(name);
      if (fail === name) throw new PapError("command_failed");
      return result;
    };
  const auth = {
    roleOf: (id: string) => users.find((user) => user.id === id)?.role ?? null,
    users: () => users,
    setBudget: vi.fn(),
    setDisabled: (id: string, disabled: boolean) => {
      log.push(`auth.setDisabled:${String(disabled)}`);
      users = users.map((user) => (user.id === id ? { ...user, disabledAt: disabled ? 1 : null } : user));
    },
    invites: { create: vi.fn(), pending: () => [], revoke: vi.fn() },
  };
  const audit = { append: vi.fn() };
  const service = createUsersService({
    clock,
    audit,
    auth: auth as unknown as UsersDeps["auth"],
    requireStepUp: (who, now) => {
      if (who.stepUpUntil <= now) throw new PapError("step_up_required");
    },
    capOf: () => 5,
    usage: { spentToday: () => 0, spentSince: () => 0, boxesRunning: () => 0 },
    disabling: createDisabling({
      boxes: { ownerBoxes: () => ["p1"], stop: step("boxes.stop", undefined) },
      agents: { list: () => [{ id: "atlas-0001" }] },
      stopAgent: step("agents.stop", undefined),
      logger: silentLogger,
    }),
    cascade: createDeleteCascade({
      db,
      github: { releaseKeysOf: step("github.releaseKeys", [] as number[]) },
      projects: { removeAll: step("projects.removeAll", 1) },
      agents: { trashAll: step("agents.trashAll", 1) },
      automation: { removeAll: step("automation.removeAll", {}) },
      sessions: { removeAll: step("sessions.removeAll", {}) },
      push: { forgetOwner: () => void log.push("push.forgetOwner") },
      search: { dropOwner: () => void log.push("search.dropOwner") },
      vault: { dropOwner: () => void log.push("vault.dropOwner") },
      auth: {
        deleteUser: (id) => {
          log.push("auth.deleteUser");
          users = users.filter((user) => user.id !== id);
        },
      },
      logger: silentLogger,
    }),
    refreshPolicies: () => void log.push("relay.refresh"),
  });
  return { service, audit };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-users-delete-"));
  db = openDatabase(join(dir, "state.db"));
  log = [];
  fail = null;
  users = [row({ id: "o1", role: "owner", budgetUsd: null }), row({ id: "m1" })];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("users delete (A5b)", () => {
  it("asks the step-up before it changes anything", async () => {
    const { service } = build();
    await expect(service.delete(caller(0), "m1")).rejects.toMatchObject({ code: "step_up_required" });
    expect(log).toEqual([]);
    expect(users.find((user) => user.id === "m1")?.disabledAt).toBeNull();
  });

  it("disables first, stops the machines, releases the signing keys before the vault is dropped, and deletes the user last", async () => {
    const { service, audit } = build();
    await service.delete(stepped(), "m1");
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
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "o1",
        reason: "user_deleted",
        detail: { userId: "m1", username: "m1" },
      }),
    );
  });

  it("a crash after step 1 leaves a disabled account, and the delete can be asked again", async () => {
    fail = "agents.trashAll";
    const { service, audit } = build();
    await expect(service.delete(stepped(), "m1")).rejects.toMatchObject({ code: "command_failed" });
    expect(users.find((user) => user.id === "m1")?.disabledAt).not.toBeNull();
    expect(log).not.toContain("vault.dropOwner");
    expect(log).not.toContain("auth.deleteUser");
    expect(audit.append).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "user_deleted" }));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "o1",
        reason: "user_disabled",
        detail: { userId: "m1", byDelete: true },
      }),
    );
    fail = null;
    await service.delete(stepped(), "m1");
    expect(users.map((user) => user.id)).toEqual(["o1"]);
  });

  it("a cascade interrupted late, after projects and agents are gone, is retried to completion", async () => {
    fail = "sessions.removeAll";
    const { service } = build();
    await expect(service.delete(stepped(), "m1")).rejects.toMatchObject({ code: "command_failed" });
    expect(users.find((user) => user.id === "m1")?.disabledAt).not.toBeNull();
    fail = null;
    log.length = 0;
    await service.delete(stepped(), "m1");
    expect(users.map((user) => user.id)).toEqual(["o1"]);
    expect(log.at(-1)).toBe("auth.deleteUser");
  });

  it("a machine that does not stop keeps the account disabled and nothing else touched", async () => {
    fail = "agents.stop";
    const { service } = build();
    await expect(service.delete(stepped(), "m1")).rejects.toMatchObject({ code: "internal" });
    expect(users.find((user) => user.id === "m1")?.disabledAt).not.toBeNull();
    expect(log).not.toContain("github.releaseKeys");
  });

  it("the owner cannot be deleted, and an unknown id is not found", async () => {
    const { service } = build();
    await expect(service.delete(stepped(), "o1")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.delete(stepped(), "ghost")).rejects.toMatchObject({ code: "not_found" });
    expect(log).toEqual([]);
    expect(users.find((user) => user.id === "o1")?.disabledAt).toBeNull();
  });
});

describe("deleteOwnerRows", () => {
  it("scans every table for owner_id and user_id, keeps runs and audit, and touches no other user", () => {
    db.exec(`
      CREATE TABLE settings (owner_id TEXT NOT NULL, key TEXT NOT NULL);
      CREATE TABLE receipts (user_id TEXT NOT NULL, id TEXT NOT NULL);
      CREATE TABLE both_columns (owner_id TEXT, user_id TEXT);
      CREATE TABLE runs (owner_id TEXT NOT NULL, id TEXT NOT NULL);
      CREATE TABLE audit (owner_id TEXT, id TEXT NOT NULL);
      CREATE TABLE no_owner (id TEXT NOT NULL);
      CREATE TABLE "odd ""name" (owner_id TEXT NOT NULL);
    `);
    for (const id of ["m1", "u1"]) {
      db.run("INSERT INTO settings VALUES ($id, 'k')", { id });
      db.run("INSERT INTO receipts VALUES ($id, 'r')", { id });
      db.run("INSERT INTO both_columns VALUES ($id, NULL)", { id });
      db.run("INSERT INTO runs VALUES ($id, 'x')", { id });
      db.run("INSERT INTO audit VALUES ($id, 'x')", { id });
      db.run('INSERT INTO "odd ""name" VALUES ($id)', { id });
    }
    db.run("INSERT INTO no_owner VALUES ('m1')");
    expect(KEPT_TABLES.has("runs") && KEPT_TABLES.has("audit") && KEPT_TABLES.size === 2).toBe(true);
    const touched = deleteOwnerRows(db, "m1");
    expect(touched.map((entry) => entry.table).sort()).toEqual([
      "both_columns",
      'odd "name',
      "receipts",
      "settings",
    ]);
    const left = (table: string, id: string) =>
      db.get<{ n: number }>(
        `SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}" WHERE ${table === "receipts" ? "user_id" : "owner_id"} = $id`,
        { id },
      )?.n;
    for (const table of ["settings", "receipts", "both_columns", 'odd "name']) {
      expect(left(table, "m1"), table).toBe(0);
      expect(left(table, "u1"), table).toBe(1);
    }
    expect(left("runs", "m1")).toBe(1);
    expect(left("audit", "m1")).toBe(1);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM no_owner")?.n).toBe(1);
  });
});
