import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { bed as makeBed, type Options, settle } from "./testing/service-bed.ts";
import { createSubagentService, SUBAGENT_PER_HOUR } from "./service.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";

const bed = (options?: Options) =>
  makeBed({ createSubagentService, createSubagentStop, createSubagentStore }, options);

describe("subagent.run refusals (M11R137)", () => {
  it("refuses a third child at once for one parent with limit_reached, and creates none", async () => {
    const b = bed();
    const first = b.service.run({ task: "1" }, b.ctx());
    const second = b.service.run({ task: "2" }, b.ctx());
    await settle();
    expect(await b.codeOf(b.service.run({ task: "3" }, b.ctx()))).toBe("limit_reached");
    expect(b.sessions.createChild).toHaveBeenCalledTimes(2);
    // Another parent has its own two.
    const other = b.service.run({ task: "x" }, b.ctx({ sessionId: "parent-2" }));
    await settle();
    expect(b.sessions.createChild).toHaveBeenCalledTimes(3);
    b.finish("child-1");
    b.finish("child-2");
    b.finish("child-3");
    await Promise.all([first, second, other]);
  });

  it("reads the concurrency from the setting, 1 to 4, at every call", async () => {
    const b = bed({ maxConcurrent: 1 });
    const first = b.service.run({ task: "1" }, b.ctx());
    await settle();
    expect(await b.codeOf(b.service.run({ task: "2" }, b.ctx()))).toBe("limit_reached");
    b.finish("child-1");
    await first;
    const again = b.service.run({ task: "3" }, b.ctx());
    await settle();
    b.finish("child-2");
    await again;
  });

  it("frees the slot when a child ends, however it ended", async () => {
    const b = bed({ maxConcurrent: 1 });
    const first = b.service.run({ task: "1" }, b.ctx());
    await settle();
    b.finish("child-1", "failed");
    await b.codeOf(first);
    const second = b.service.run({ task: "2" }, b.ctx());
    await settle();
    b.finish("child-2");
    await second;
  });

  it("refuses the 31st child an hour for one owner with rate_limited, and counts again after the hour", async () => {
    const b = bed({ maxConcurrent: 4 });
    for (let at = 0; at < SUBAGENT_PER_HOUR; at += 1) {
      const call = b.service.run({ task: `t${at}` }, b.ctx());
      await settle();
      b.finish(`child-${at + 1}`);
      await call;
    }
    expect(await b.codeOf(b.service.run({ task: "late" }, b.ctx()))).toBe("rate_limited");
    expect(b.sessions.createChild).toHaveBeenCalledTimes(SUBAGENT_PER_HOUR);
    await b.clock.advance(3_600_001);
    const call = b.service.run({ task: "next hour" }, b.ctx());
    await settle();
    b.finish(`child-${SUBAGENT_PER_HOUR + 1}`);
    await call;
  });

  it("refuses with unavailable when the pool has no worker to spare, and writes nothing", async () => {
    const b = bed({ admits: false });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe("unavailable");
    expect(b.sessions.createChild).not.toHaveBeenCalled();
    expect(b.store.startedSince("u1", 0)).toBe(0);
  });

  it("refuses with budget when the agent is over its own, and asks only for an agent's call", async () => {
    const b = bed({ over: true });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx({ agentId: "atlas-1a2b" })))).toBe("budget");
    expect(b.agents.over).toHaveBeenCalledWith("u1", "atlas-1a2b");
    expect(b.sessions.createChild).not.toHaveBeenCalled();
    const plain = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.agents.over).toHaveBeenCalledTimes(1);
    b.finish("child-1");
    await plain;
  });

  it("answers unavailable when the switch is off, without a child", async () => {
    const b = bed({ enabled: false });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe("unavailable");
    expect(b.sessions.createChild).not.toHaveBeenCalled();
    expect(b.service.enabled("u1")).toBe(false);
    expect(bed().service.enabled("u1")).toBe(true);
  });

  it("maps the profile's refusals and ends the row failed", async () => {
    const missing = bed({ profileError: new PapError("not_found") });
    expect(await missing.codeOf(missing.service.run({ task: "t", profile: "nope" }, missing.ctx()))).toBe(
      "not_found",
    );
    expect(missing.store.get("id-1")).toMatchObject({ state: "failed", reason: "profile_not_found" });
    const twice = bed({ profileError: new PapError("conflict") });
    expect(await twice.codeOf(twice.service.run({ task: "t", profile: "dup" }, twice.ctx()))).toBe(
      "bad_request",
    );
    expect(twice.store.get("id-1")).toMatchObject({ state: "failed", reason: "profile_ambiguous" });
    const broken = bed({ profileError: new PapError("helper_failed") });
    expect(await broken.codeOf(broken.service.run({ task: "t", profile: "x" }, broken.ctx()))).toBe(
      "unavailable",
    );
    expect(broken.sessions.createChild).not.toHaveBeenCalled();
  });

  it.each([
    ["capacity", "unavailable"],
    ["disk_low", "unavailable"],
    ["sandbox_unavailable", "sandbox_unavailable"],
    ["agent_paused", "paused"],
    ["bad_request", "bad_request"],
    ["not_found", "not_found"],
  ] as const)(
    "maps a child session that cannot start (%s) to %s and ends the row failed",
    async (code, platform) => {
      const b = bed({ createError: new PapError(code) });
      expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe(platform);
      expect(b.store.get("id-1")).toMatchObject({ state: "failed", reason: `child_${code}` });
      expect(b.store.liveOf("parent")).toBe(0);
    },
  );

  it("ends the row failed and clears the expected origin when the prompt is refused", async () => {
    const b = bed({ promptError: new PapError("worker_failed") });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe("internal");
    expect(b.store.get("id-1")).toMatchObject({
      state: "failed",
      reason: "prompt_failed",
      childSessionId: "child-1",
    });
    expect(b.calls).toContainEqual(["clearExpected", "child-1"]);
    expect(b.listeners.size).toBe(0);
  });
});

describe("subagent.run endings", () => {
  it.each([
    ["failed", "failed", "provider", "internal"],
    ["limited", "failed", "usage_limit", "unavailable"],
    ["cancelled", "cancelled", "aborted", "cancelled"],
    ["interrupted", "interrupted", "crash", "internal"],
  ] as const)(
    "a child whose run %s ends the row %s (%s) and answers %s",
    async (status, state, reason, code) => {
      const b = bed();
      const call = b.service.run({ task: "t" }, b.ctx());
      await settle();
      b.finish("child-1", status);
      expect(await b.codeOf(call)).toBe(code);
      expect(b.store.get("id-1")).toMatchObject({ state, reason });
    },
  );

  it("aborts the child and ends the row cancelled when the parent's call is cancelled", async () => {
    const b = bed();
    const controller = new AbortController();
    const call = b.service.run({ task: "t" }, b.ctx({ signal: controller.signal }));
    await settle();
    controller.abort();
    expect(await b.codeOf(call)).toBe("cancelled");
    expect(b.calls).toContainEqual(["abort", "child-1"]);
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "stopped" });
    expect(b.listeners.size).toBe(0);
  });

  it("ends a call already cancelled before it started without making a child", async () => {
    const b = bed();
    const controller = new AbortController();
    controller.abort();
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx({ signal: controller.signal })))).toBe(
      "cancelled",
    );
    expect(b.sessions.createChild).not.toHaveBeenCalled();
  });
});

describe("an agent's child counts in the agent's budget (M11R137)", () => {
  it("runs the agent thread's call like a plain one once the budget is not reached", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx({ type: "agent-thread", agentId: "atlas-1a2b" }));
    await settle();
    expect(b.agents.over).toHaveBeenCalledWith("u1", "atlas-1a2b");
    b.finish("child-1");
    await call;
    expect(b.store.get("id-1")?.state).toBe("done");
  });
});
