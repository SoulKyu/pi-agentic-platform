import { PapError } from "@pap/contracts";
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
const limit = (): string => t.limitRun("You have hit your usage limit. Try again in ~1 min.");
const outboxRows = (): number => t.bed.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n ?? 0;
const reachReset = () => t.bed.clock.advance(MIN + 60_000);
const browser = { userId: "u1", kind: "session" };

describe("auto-resume of a full-access agent thread whose sandbox is on (owner a5, decision 90)", () => {
  it("is planned and sent with sandboxedOnly", async () => {
    t.sessions.mode = "full-access";
    t.sessions.sandboxedAgent = true;
    limit();
    expect(outboxRows()).toBe(1);
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
    expect(t.sessions.sandboxedOnly).toEqual([true]);
  });

  it("is not planned when the sandbox is not on", () => {
    t.sessions.mode = "full-access";
    t.sessions.sandboxedAgent = false;
    limit();
    expect(outboxRows()).toBe(0);
  });

  it("is skipped as full_access when the sandbox went off after it was planned", async () => {
    t.sessions.mode = "full-access";
    t.sessions.sandboxedAgent = true;
    limit();
    t.sessions.sandboxedAgent = false;
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:full_access"]);
  });

  it("keeps an owner session in full access held, as before", () => {
    t.sessions.mode = "full-access";
    limit();
    expect(outboxRows()).toBe(0);
  });

  it("changes nothing outside full access: no sandboxedOnly on the send", async () => {
    t.sessions.sandboxedAgent = true;
    limit();
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.sandboxedOnly).toEqual([undefined]);
  });

  it("skips, done and without a retry, when the send answers sandbox_unavailable", async () => {
    t.sessions.mode = "full-access";
    t.sessions.sandboxedAgent = true;
    t.sessions.onPrompt = () => {
      throw new PapError("sandbox_unavailable");
    };
    limit();
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
    expect(t.skipped).toEqual(["s1:full_access"]);
    expect(t.row()).toMatchObject({ status: "done" });
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });

  it("fails, with the code and no full_access skip, when a supervised thread's send answers sandbox_unavailable", async () => {
    t.sessions.sandboxedAgent = true;
    t.sessions.onPrompt = () => {
      throw new PapError("sandbox_unavailable");
    };
    limit();
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.sandboxedOnly).toEqual([undefined]);
    expect(t.skipped).toEqual(["s1:send_failed"]);
    expect(t.row()).toMatchObject({ status: "failed" });
  });

  it("never passes sandboxedOnly from resumeNow", async () => {
    t.sessions.mode = "full-access";
    t.sessions.sandboxedAgent = true;
    t.limitRun("insufficient_quota");
    await t.resume.resumeNow(browser, "s1");
    expect(t.sessions.sandboxedOnly).toEqual([undefined]);
  });
});
