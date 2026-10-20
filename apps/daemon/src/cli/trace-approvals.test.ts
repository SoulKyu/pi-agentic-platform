import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../kernel/clock.ts";
import { type Db, openDatabase } from "../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "../modules/audit/index.ts";
import { createPolicyLink } from "../modules/sessions/policy-link.ts";
import { fakePolicyPort } from "../modules/sessions/testing/fake-policy.ts";
import { runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";
import { summarizeApprovals } from "./trace-approvals.ts";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
let dir: string;
let home: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-trace-approvals-"));
  home = join(dir, "home");
  mkdirSync(home);
  db = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS],
    clock: createFakeClock(NOW),
    logger: silentLogger,
  }).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One call row: asked `agoMs` before NOW, answered `tookMs` later with `answer` (null: never answered). */
function call(agoMs: number, tookMs: number | null, answer: string | null, decision = "approved"): void {
  const at = NOW - agoMs;
  db.run(
    "INSERT INTO audit (at, month, actor, kind, decision, reason, asked_at, answers, answered_at, answer) " +
      "VALUES ($at, strftime('%Y-%m', $at / 1000, 'unixepoch'), 'worker', 'call', $decision, 'r', $at, '[\"deny\",\"once\"]', $answeredAt, $answer)",
    { at, decision, answer, answeredAt: tookMs === null ? null : at + tookMs },
  );
}

describe("summarizeApprovals", () => {
  it("counts asked, answered and each answer, with the median, the p90 and the share answered in 2 s or less", () => {
    // Ten answered cards: 500 1000 1500 2000 | 2001 3000 4000 5000 6000 20000, plus one nobody answered and a plain allow.
    const took = [500, 1000, 1500, 2000, 2001, 3000, 4000, 5000, 6000, 20000];
    const answers = ["once", "once", "once", "once", "once", "once", "session", "always", "host", "deny"];
    // The choice is the column, whatever the call's decision became (a policy that moved refuses an approved answer).
    took.forEach((ms, i) => call(60_000 + i, ms, answers[i] ?? "once", i % 2 ? "denied" : "approved"));
    call(1_000, null, null, "denied");
    db.run(
      "INSERT INTO audit (at, month, actor, kind, decision) VALUES (1, '1970-01', 'worker', 'call', 'allow')",
    );
    const summary = summarizeApprovals(db, { now: NOW });
    expect(Object.values(summary.byAnswer).reduce((sum, n) => sum + n, 0)).toBe(summary.answered);
    expect(summary).toEqual({
      asked: 11,
      answered: 10,
      byAnswer: { once: 6, session: 1, always: 1, deny: 1, host: 1 },
      medianMs: 2001,
      p90Ms: 6000,
      fastShare: 0.4,
    });
  });

  it("keeps only the cards asked within --since", () => {
    call(30 * 60_000, 1000, "once");
    call(10 * 60_000, 1000, "once");
    expect(summarizeApprovals(db, { now: NOW, sinceMs: 15 * 60_000 }).asked).toBe(1);
    expect(summarizeApprovals(db, { now: NOW }).asked).toBe(2);
  });

  it("shows zeros for an empty window, without dividing by zero", () => {
    expect(summarizeApprovals(db, { now: NOW })).toEqual({
      asked: 0,
      answered: 0,
      byAnswer: { once: 0, session: 0, always: 0, deny: 0, host: 0 },
      medianMs: 0,
      p90Ms: 0,
      fastShare: 0,
    });
  });

  it("counts a card nobody answered as asked only", () => {
    call(1000, null, null, "denied");
    expect(summarizeApprovals(db, { now: NOW })).toMatchObject({
      asked: 1,
      answered: 0,
      medianMs: 0,
      fastShare: 0,
    });
  });
});

describe("summarizeApprovals over rows the real writer path wrote", () => {
  const ROW = { id: "s1", cwd: "/work", ownerId: "u1" } as never;
  const worker = (toolCallId: string, decision: string) => ({
    kind: "call",
    toolCallId,
    tool: "bash",
    category: "exec",
    decision,
    stages: [],
    args: "ls",
  });

  it("counts what the owner chose: once, deny, an answer the policy then refused, and a card nobody answered", async () => {
    const clock = createFakeClock(NOW);
    const audit = createAuditModule({ db, clock, logger: silentLogger });
    const link = createPolicyLink({
      policy: fakePolicyPort(),
      audit: audit.port,
      containment: "none",
      clock,
      logger: silentLogger,
      hub: { publish: () => {} },
      sessions: () => [],
      toolPreset: () => null,
    });
    const answered = async (
      id: string,
      answer: "once" | "deny" | "always",
      took: number,
      decision: string,
    ) => {
      link.cardShown(ROW, id, ["deny", "once", "always"], clock.now());
      await clock.advance(took);
      link.answeredBy(ROW, id, { userId: "u1", credentialId: "dev1" } as never, answer);
      link.audited(ROW, worker(id, decision));
    };
    await answered("c1", "once", 1_000, "approved");
    await answered("c2", "deny", 3_000, "denied");
    await answered("c3", "always", 500, "block");
    link.cardShown(ROW, "c4", ["deny", "once"], clock.now());
    link.audited(ROW, worker("c4", "denied"));
    const summary = summarizeApprovals(db, { now: clock.now() + 1 });
    expect(summary).toMatchObject({
      asked: 4,
      answered: 3,
      byAnswer: { once: 1, deny: 1, always: 1, session: 0, host: 0 },
    });
    expect(Object.values(summary.byAnswer).reduce((sum, n) => sum + n, 0)).toBe(summary.answered);
  });
});

describe("pap trace summary prints the approvals block", () => {
  it("after the span table, from the database, read-only", async () => {
    mkdirSync(join(home, "logs"));
    writeFileSync(
      join(home, "logs", "trace.jsonl"),
      `${JSON.stringify({ name: "hook", start: NOW - 1000, durationMs: 5, outcome: "ok", attrs: {} })}\n`,
    );
    call(1000, 1500, "once");
    call(2000, 9000, "always");
    db.close();
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    const out = stdout();
    expect(out).toMatch(/^hook\s+1/m);
    expect(out).toContain("approvals: asked 2, answered 2");
    expect(out).toContain("by answer: once 1, session 0, always 1, deny 0, host 0");
    expect(out).toContain("time to answer: median 1.5 s, p90 9.0 s; answered in 2 s or less: 50 %");
    db = openDatabase(join(home, "state.db"));
  });

  it("prints zeros when the window holds no card, and shows the block even with no trace file", async () => {
    db.close();
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    expect(stdout()).toContain("no trace yet");
    expect(stdout()).toContain("approvals: asked 0, answered 0");
    expect(stdout()).toContain("time to answer: median 0.0 s, p90 0.0 s; answered in 2 s or less: 0 %");
    db = openDatabase(join(home, "state.db"));
  });

  it("leaves the block out for a database from before the card timing columns", async () => {
    db.exec("DROP TABLE audit");
    db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, kind TEXT)");
    db.close();
    const { io, stdout } = cliIo({ env: { PAP_HOME: home }, now: NOW });
    expect(await runCli(["trace", "summary"], io)).toBe(0);
    expect(stdout()).not.toContain("approvals");
    db = openDatabase(join(home, "state.db"));
  });
});
