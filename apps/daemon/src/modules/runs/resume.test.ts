import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverOutbox } from "../../kernel/outbox/store.ts";
import { assistantEnd } from "./testing/events.ts";
import { createResume, RESUME_PROMPT, resumeJitter, resumeKey } from "./resume.ts";
import { openResumeBed as openBed, SESSION, type ResumeBed } from "./testing/resume-bed.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";

let t: ResumeBed;
beforeEach(() => {
  t = openBed({ createRunsService, createRunsStore, createResume });
});
afterEach(() => t.close());

const MIN = 60_000;
const limit = (): string => t.limitRun("You have hit your usage limit. Try again in ~1 min.");
const outboxRows = (): number => t.bed.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n ?? 0;
const reachReset = () => t.bed.clock.advance(MIN + 60_000);

describe("scheduling (M10R104)", () => {
  it("writes one run.resume with the run's end, owned by the owner, due at the reset plus the session's jitter", () => {
    const runId = limit();
    const row = t.runs.lookup.get(runId);
    expect(row).toMatchObject({ status: "limited", errorClass: "usage_limit" });
    expect(outboxRows()).toBe(1);
    const resetAt = t.bed.clock.now() + MIN;
    expect(row?.limitResetAt).toBe(resetAt);
    const stored = t.bed.db.get<{
      kind: string;
      owner_id: string;
      dedup_key: string;
      next_at: number;
      payload: string;
    }>("SELECT kind, owner_id, dedup_key, next_at, payload FROM outbox");
    expect(stored).toMatchObject({
      kind: "run.resume",
      owner_id: "u1",
      dedup_key: resumeKey("s1", runId, resetAt),
      next_at: resetAt + resumeJitter("s1"),
    });
    expect(JSON.parse(stored?.payload ?? "{}")).toEqual({ sessionId: "s1", runId, resetAt });
  });

  it("keeps the jitter within 60 s and stable for a session", () => {
    for (const id of ["s1", "s2", "a-long-session-id-0123456789"]) {
      expect(resumeJitter(id)).toBe(resumeJitter(id));
      expect(resumeJitter(id)).toBeGreaterThanOrEqual(0);
      expect(resumeJitter(id)).toBeLessThan(60_000);
    }
    expect(new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map(resumeJitter)).size).toBeGreaterThan(1);
  });

  it("writes none for a second report of the same run (the receipt)", () => {
    const runId = limit();
    const row = t.runs.lookup.get(runId);
    if (!row) throw new Error("no row");
    t.resume.plan(row);
    expect(outboxRows()).toBe(1);
  });

  it("writes none when auto-resume is off, in full-access, or without a reset time", () => {
    t.settings.autoResume = false;
    limit();
    expect(outboxRows()).toBe(0);
    t.settings.autoResume = true;
    t.sessions.mode = "full-access";
    limit();
    expect(outboxRows()).toBe(0);
    t.sessions.mode = "supervised";
    t.limitRun("insufficient_quota");
    expect(outboxRows()).toBe(0);
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ status: "limited", limitResetAt: null });
  });

  it("writes none for a child session, and says so (M11R139)", () => {
    t.sessions.child = true;
    limit();
    expect(outboxRows()).toBe(0);
    expect(t.skipped).toEqual(["s1:child"]);
  });

  it("leaves a plain provider error failed, with no resume", () => {
    t.limitRun("Invalid API key");
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ status: "failed", errorClass: "provider" });
    expect(outboxRows()).toBe(0);
  });

  it("keeps the run closed when the planner throws", () => {
    t.sessions.mode = "throw";
    const runId = t.limitRun("usage limit, try again in ~1 min");
    expect(t.runs.lookup.get(runId)?.status).toBe("limited");
  });
});

describe("the handler (M10R105)", () => {
  it("prompts once after the reset with the resume origin and T3's text, then settles done", async () => {
    const runId = limit();
    await t.bed.clock.advance(MIN - 1);
    expect(await t.outbox.drain()).toBe(0);
    await reachReset();
    expect(await t.outbox.drain()).toBe(1);
    expect(t.sessions.prompts).toEqual([RESUME_PROMPT]);
    expect(RESUME_PROMPT).toBe("Continue where you left off.");
    expect(t.expected).toEqual([{ origin: "resume", taskId: null }]);
    expect(t.row()?.status).toBe("done");
    expect(await t.outbox.drain()).toBe(0);
    expect(runId).toBe("run-1");
  });

  it("marks the point of no return before it prompts", async () => {
    limit();
    let sentWhenPrompted: number | null | undefined;
    t.sessions.onPrompt = () => {
      sentWhenPrompted = t.row()?.sent_at;
    };
    await reachReset();
    await t.outbox.drain();
    expect(sentWhenPrompted).not.toBeNull();
    expect(sentWhenPrompted).not.toBeUndefined();
  });

  it("retires the row at recovery when the daemon dies between the mark and the prompt, never prompting twice", async () => {
    limit();
    let booted = false;
    t.sessions.onPrompt = () => {
      // The boot of the next life, while this life's handler is between its mark and the answer.
      if (!booted) recoverOutbox(t.bed.db, t.bed.clock.now());
      booted = true;
    };
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
    t.sessions.onPrompt = () => {};
    expect(await t.outbox.drain()).toBe(0);
    expect(t.sessions.prompts).toHaveLength(1);
    expect(t.row()?.status).toBe("retired");
  });

  it("skips after a newer run (new input wins), telling the runner", async () => {
    limit();
    t.startRun();
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:newer_input"]);
    expect(t.row()?.sent_at).toBeNull();
  });

  it("skips when a prompt is in flight now", async () => {
    limit();
    t.sessions.running = true;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:newer_input"]);
  });

  it("skips an archived session", async () => {
    limit();
    t.sessions.archived = true;
    await reachReset();
    await t.outbox.drain();
    expect(t.skipped).toEqual(["s1:archived"]);
    expect(t.sessions.prompts).toEqual([]);
  });

  it("skips a session that is gone, silently", async () => {
    limit();
    t.sessions.exists = false;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual([]);
    expect(t.row()?.status).toBe("done");
  });

  it("never runs a pending effect that was cancelled: it is retired", async () => {
    const runId = limit();
    const row = t.runs.lookup.get(runId);
    expect(t.outbox.cancel(resumeKey("s1", runId, row?.limitResetAt ?? 0))).toBe("retired");
    await reachReset();
    expect(await t.outbox.drain()).toBe(0);
    expect(t.sessions.prompts).toEqual([]);
  });

  it("reads a cancel mark made during an earlier lease before it prompts", async () => {
    limit();
    // A cancel marked a leased row; the daemon died before it settled; the boot put the row back to pending.
    t.bed.db.run("UPDATE outbox SET cancel_requested = 1");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()?.sent_at).toBeNull();
  });

  it("skips after a switch to full-access", async () => {
    limit();
    t.sessions.mode = "full-access";
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:full_access"]);
  });

  it("skips an effect written before the session was known as a child (M11R139)", async () => {
    limit();
    t.sessions.child = true;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:child"]);
  });

  it("skips over the daily budget, live cost included, and says so", async () => {
    limit();
    t.settings.dailyBudgetUsd = 2;
    // Another session's task run in flight has already spent 3 today.
    t.runs.port.expectOrigin("s2", { origin: "trigger", taskId: "t9" });
    t.runs.observer.onRecord({ id: "s2", ownerId: "u1" }, "run_start", {}, null);
    t.runs.observer.onEvent("s2", (await import("./testing/events.ts")).assistantEnd({ cost: 3 }));
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:budget"]);
  });

  it("resumes with no budget at all, and refuses at a budget of 0", async () => {
    limit();
    t.settings.dailyBudgetUsd = 0;
    await reachReset();
    await t.outbox.drain();
    expect(t.skipped).toEqual(["s1:budget"]);
    t.skipped.length = 0;
    t.settings.dailyBudgetUsd = null;
    t.limitRun("usage limit, try again in ~1 min");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("defers five minutes at capacity, before the sent mark", async () => {
    limit();
    t.sessions.admits = false;
    await reachReset();
    const now = t.bed.clock.now();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()).toMatchObject({ status: "pending", sent_at: null, next_at: now + 5 * MIN });
    t.sessions.admits = true;
    await t.bed.clock.advance(5 * MIN);
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("ends done, clearing the origin it asked for, when Pi refuses because the owner got there first", async () => {
    limit();
    t.sessions.onPrompt = () => {
      throw new PapError("session_busy");
    };
    await reachReset();
    await t.outbox.drain();
    expect(t.row()?.status).toBe("done");
    expect(t.skipped).toEqual(["s1:send_failed", "s1:newer_input"]);
    t.startRun("user");
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ origin: "user" });
  });

  it("fails the effect, with the error's code, when the prompt breaks for another reason", async () => {
    limit();
    t.sessions.onPrompt = () => {
      throw new PapError("worker_failed");
    };
    await reachReset();
    await t.outbox.drain();
    expect(t.row()?.status).toBe("failed");
    expect(t.skipped).toEqual(["s1:send_failed"]);
  });

  it("says a continuation is on its way from the mark until the prompt settles", async () => {
    limit();
    const during: boolean[] = [];
    t.sessions.onPrompt = () => void during.push(t.resume.sending("s1"));
    await reachReset();
    await t.outbox.drain();
    expect(during).toEqual([true]);
    expect(t.resume.sending("s1")).toBe(false);
  });
});

describe("spend (money focus)", () => {
  it("counts the limited run and its continuation once each, the continuation under the task's budget", async () => {
    t.runs.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    limit();
    expect(t.runs.port.spentToday("u1", null)).toBeCloseTo(0.1);
    t.sessions.onPrompt = () => {
      // Pi starts the continuation: the origin and task the handler asked for are taken, then 0.2 is spent.
      t.startRun();
      t.runs.observer.onEvent("s1", assistantEnd({ cost: 0.2 }));
      expect(t.runs.port.spentToday("u1", null)).toBeCloseTo(0.3);
    };
    await reachReset();
    await t.outbox.drain();
    t.runs.observer.onRecord(SESSION, "run_end", {}, null);
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({
      origin: "resume",
      taskId: "t1",
      status: "completed",
    });
    expect(t.runs.port.spentToday("u1", null)).toBeCloseTo(0.3);
    expect(t.runs.port.spentTodayOf("u1", null, ["t1"])).toBeCloseTo(0.3);
  });
});

describe("resumeNow and cancelResume (M10R106)", () => {
  const browser = { userId: "u1", kind: "session" } as const;
  const token = { userId: "u1", kind: "token" } as const;

  it("sends now, cancelling the scheduled effect so it never sends a second time", async () => {
    limit();
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toEqual([RESUME_PROMPT]);
    expect(t.row()?.status).toBe("retired");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("ignores the budget for a browser session and applies it to a token", async () => {
    limit();
    t.settings.dailyBudgetUsd = 0;
    await expect(t.resume.resumeNow(token, "s1")).rejects.toMatchObject({ code: "budget_reached" });
    expect(t.sessions.prompts).toEqual([]);
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("works in full-access and without a reset time (the chip's only action there)", async () => {
    t.sessions.mode = "full-access";
    t.limitRun("insufficient_quota");
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("answers not_found for another owner's or a missing session, conflict when nothing is limited", async () => {
    await expect(t.resume.resumeNow({ userId: "u2", kind: "session" }, "s1")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(t.resume.resumeNow(browser, "s1")).rejects.toMatchObject({ code: "conflict" });
    limit();
    t.startRun();
    await expect(t.resume.resumeNow(browser, "s1")).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses at capacity and while the session works, and a second click while the first is sending", async () => {
    limit();
    t.sessions.admits = false;
    await expect(t.resume.resumeNow(browser, "s1")).rejects.toMatchObject({ code: "capacity" });
    t.sessions.admits = true;
    t.sessions.running = true;
    await expect(t.resume.resumeNow(browser, "s1")).rejects.toMatchObject({ code: "session_busy" });
    t.sessions.running = false;
    let second: Promise<void> | undefined;
    t.sessions.onPrompt = () => {
      second = t.resume.resumeNow(browser, "s1");
    };
    await t.resume.resumeNow(browser, "s1");
    await expect(second).rejects.toMatchObject({ code: "conflict" });
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("cancels a pending resume, leaving the run limited and telling the stream", async () => {
    limit();
    await t.resume.cancelResume("u1", "s1");
    expect(t.row()?.status).toBe("retired");
    expect(t.changed).toEqual(["s1"]);
    expect(t.runs.lookup.latestOf("s1")?.status).toBe("limited");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    await expect(t.resume.cancelResume("u2", "s1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("names the keys of a session's pending resume for a cancelled task", () => {
    const runId = limit();
    const resetAt = t.runs.lookup.get(runId)?.limitResetAt ?? 0;
    expect(t.resume.keysOf(SESSION.id)).toEqual([resumeKey("s1", runId, resetAt)]);
    t.startRun();
    expect(t.resume.keysOf(SESSION.id)).toEqual([]);
  });
});
