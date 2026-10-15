import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createResume } from "./resume.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { openResumeBed as openBed, type ResumeBed } from "./testing/resume-bed.ts";

let t: ResumeBed;
beforeEach(() => {
  t = openBed({ createRunsService, createRunsStore, createResume });
});
afterEach(() => t.close());

const MIN = 60_000;
const browser = { userId: "u1", kind: "session" } as const;
const token = { userId: "u1", kind: "token" } as const;
const originOfLastRun = (): string | undefined =>
  t.bed.db.get<{ origin: string }>("SELECT origin FROM runs ORDER BY rowid DESC LIMIT 1")?.origin;

describe("the resume's expected origin (final review T17 m5)", () => {
  it("is cleared when the continuation started no run, so the owner's next run is the owner's own", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    t.sessions.disposition = "handled";
    await t.bed.clock.advance(MIN + MIN);
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);

    t.startRun();

    expect(originOfLastRun()).toBe("user");
    expect(t.skipped).toEqual(["s1:handled"]);
  });

  it("stays armed for a continuation that started or queued", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    await t.bed.clock.advance(MIN + MIN);
    await t.outbox.drain();

    t.startRun();

    expect(originOfLastRun()).toBe("resume");
  });
});

describe("usage.resumeNow origin (final review)", () => {
  it("a token's Resume now runs under origin resume: counted and abortable by the budget", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    await t.resume.resumeNow(token, "s1");
    t.startRun();
    expect(originOfLastRun()).toBe("resume");
  });

  it("the owner's browser click stays origin user", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    await t.resume.resumeNow(browser, "s1");
    t.startRun();
    expect(originOfLastRun()).toBe("user");
  });

  it("a token's click that started no run leaves nothing armed", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    t.sessions.disposition = "handled";
    await t.resume.resumeNow(token, "s1");
    t.startRun();
    expect(originOfLastRun()).toBe("user");
  });

  it("a token's click that the full table of expectations cannot tag waits as capacity, sending nothing", async () => {
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    for (let index = 0; index < 64; index++)
      t.runs.port.expectOrigin(`x${index}`, { origin: "resume", taskId: null });
    await expect(t.resume.resumeNow(token, "s1")).rejects.toMatchObject({ code: "capacity" });
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()?.status).toBe("pending");
  });
});
