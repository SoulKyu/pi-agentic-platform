import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverOutbox } from "../../kernel/outbox/store.ts";
import { createResume } from "./resume.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { assistantEnd } from "./testing/events.ts";
import { openResumeBed, SESSION, type ResumeBed } from "./testing/resume-bed.ts";

let t: ResumeBed;
beforeEach(() => {
  t = openResumeBed({ createRunsService, createRunsStore, createResume });
});
afterEach(() => t.close());

const MIN = 60_000;
const limit = (): string => t.limitRun("You have hit your usage limit. Try again in ~1 min.");
const reachReset = () => t.bed.clock.advance(MIN + 60_000);

describe("fix round 1: pending input, pause, Resume now, origin", () => {
  const browser = { userId: "u1", kind: "session" } as const;
  const token = { userId: "u1", kind: "token" } as const;

  it("I1: defers while an owner prompt or reopen is in flight, then skips on their run", async () => {
    limit();
    t.sessions.pending = true;
    await reachReset();
    await t.outbox.drain();
    const now = t.bed.clock.now();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.expected).toEqual([]);
    expect(t.row()).toMatchObject({ status: "pending", sent_at: null, next_at: now + 30_000 });
    // Their run starts first and keeps its own origin; the retry finds it and skips.
    t.sessions.pending = false;
    t.startRun("user");
    await t.bed.clock.advance(30_000);
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:newer_input"]);
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ origin: "user" });
  });

  it("I2: defers while automation is paused, and sends once it is lifted", async () => {
    limit();
    t.settings.paused = true;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()).toMatchObject({ status: "pending", sent_at: null });
    t.settings.paused = false;
    await t.bed.clock.advance(5 * MIN);
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("I2: a paused owner with a spent budget defers; unpaused, the same spend skips with budget", async () => {
    limit();
    t.settings.dailyBudgetUsd = 0;
    t.settings.paused = true;
    await reachReset();
    await t.outbox.drain();
    expect(t.skipped).toEqual([]);
    expect(t.row()).toMatchObject({ status: "pending", sent_at: null });
    t.settings.paused = false;
    await t.bed.clock.advance(5 * MIN);
    await t.outbox.drain();
    expect(t.skipped).toEqual(["s1:budget"]);
    expect(t.sessions.prompts).toEqual([]);
  });

  it("I2: reads auto-resume again at fire time", async () => {
    limit();
    t.settings.autoResume = false;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()).toMatchObject({ status: "done", sent_at: null });
  });

  it("I2: a token gets automation_paused while paused; the owner's browser does not", async () => {
    limit();
    t.settings.paused = true;
    await expect(t.resume.resumeNow(token, "s1")).rejects.toMatchObject({ code: "automation_paused" });
    expect(t.sessions.prompts).toEqual([]);
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("I3: Resume now sends exactly once after a scheduled send failed past its mark", async () => {
    limit();
    t.sessions.onPrompt = () => {
      throw new PapError("worker_failed");
    };
    await reachReset();
    await t.outbox.drain();
    expect(t.row()).toMatchObject({ status: "failed" });
    t.sessions.onPrompt = () => {};
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(2);
  });

  it("I3: Resume now sends after the boot retired a send that crashed", async () => {
    limit();
    t.sessions.onPrompt = () => {
      recoverOutbox(t.bed.db, t.bed.clock.now());
    };
    await reachReset();
    await t.outbox.drain();
    expect(t.row()).toMatchObject({ status: "retired" });
    t.sessions.onPrompt = () => {};
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(2);
  });

  it("I3: Resume now sends after a scheduled send that Pi handled without a run", async () => {
    limit();
    await reachReset();
    await t.outbox.drain();
    expect(t.row()).toMatchObject({ status: "done" });
    expect(t.runs.lookup.latestOf("s1")?.status).toBe("limited");
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.prompts).toHaveLength(2);
  });

  it("I5: a click-resume runs under the owner's origin, never counted as automation spend", async () => {
    limit();
    t.sessions.onPrompt = () => {
      t.startRun();
      t.runs.observer.onEvent("s1", assistantEnd({ cost: 4 }));
    };
    await t.resume.resumeNow(browser, "s1");
    expect(t.expected).toEqual([]);
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ origin: "user", taskId: null });
    expect(t.runs.port.spentToday("u1", null)).toBe(0);
    t.runs.observer.onRecord(SESSION, "run_end", {}, null);
    expect(t.runs.port.spentToday("u1", null)).toBe(0);
  });

  it("I5: the scheduled resume keeps the resume origin", async () => {
    limit();
    await reachReset();
    await t.outbox.drain();
    expect(t.expected).toEqual([{ origin: "resume", taskId: null }]);
  });
});
