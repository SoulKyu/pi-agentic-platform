import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { fakePool, type RunCall } from "../models/testing/bed.ts";
import { createProfiles } from "./profiles.ts";

const NONE = { parse: 0, refused: 0, tooLarge: 0 };
const USER = { name: "scout", description: "Fast recon", source: "user" };
const PROJECT = { name: "repo-reviewer", description: "Knows this repo", source: "project" };

/** Like the real helper: the project's profiles come only with the run's folder. */
const helperAnswer = (call: RunCall): unknown => ({
  profiles: call.options.cwd === undefined ? [USER] : [PROJECT, USER],
  truncated: false,
  skipped: NONE,
});

function bed(trusted: boolean | null, answer: (call: RunCall) => unknown = helperAnswer, agent = false) {
  const { pool, calls } = fakePool(answer);
  const { logger, lines } = captureLogger();
  const profiles = createProfiles({
    pi: { helpers: pool, trust: { status: async () => trusted } },
    sessions: {
      cwdOf: (owner, id) => (owner === "u1" && id === "s1" ? "/w/api" : null),
      runsInVm: () => agent,
    },
    logger,
  });
  return { profiles, calls, lines };
}
const caller = testCaller();
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("subagents.profiles", () => {
  it("lists the user profiles, sorted, and the project ones when the session's folder is trusted", async () => {
    const { profiles, calls } = bed(true);
    expect(await profiles.list(caller, "s1")).toEqual({
      profiles: [PROJECT, USER],
      truncated: false,
      skipped: NONE,
    });
    expect(calls[0]).toMatchObject({ op: "subagents.profiles", options: { cwd: "/w/api" } });
  });

  it.each([false, null])(
    "lists only the user profiles when the folder is not trusted (%s)",
    async (trusted) => {
      const { profiles, calls } = bed(trusted);
      expect((await profiles.list(caller, "s1")).profiles).toEqual([USER]);
      expect(calls[0]?.options).not.toHaveProperty("cwd");
    },
  );

  it("never passes the folder for an agent's session, even when Pi trusts it (W5-R27, W5-R29)", async () => {
    const { profiles, calls } = bed(true, helperAnswer, true);
    expect((await profiles.list(caller, "s1")).profiles).toEqual([USER]);
    expect(calls[0]?.options).not.toHaveProperty("cwd");
  });

  it("carries the offline switch in every helper call", async () => {
    for (const trusted of [true, false]) {
      const { profiles, calls } = bed(trusted);
      await profiles.list(caller, "s1");
      expect(calls[0]?.params).toEqual({ offline: true });
    }
  });

  it("answers not_found for a session that is not the caller's, before any helper starts", async () => {
    const { profiles, calls } = bed(true);
    expect(await codeOf(profiles.list(caller, "other"))).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("logs what the helper skipped, with the session, only when something was", async () => {
    const skipped = { parse: 2, refused: 1, tooLarge: 3 };
    const { profiles, lines } = bed(true, () => ({ profiles: [USER], truncated: false, skipped }));
    await profiles.list(caller, "s1");
    const logged = lines.filter((line) => line["msg"] === "subagent_profiles_skipped");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ sessionId: "s1", ...skipped });
    const quiet = bed(true);
    await quiet.profiles.list(caller, "s1");
    expect(quiet.lines.filter((line) => line["msg"] === "subagent_profiles_skipped")).toEqual([]);
  });

  it("fails closed when the helper answers a field the contract does not list", async () => {
    const { profiles } = bed(true, () => ({
      profiles: [{ ...USER, systemPrompt: "SECRET" }],
      truncated: false,
      skipped: NONE,
    }));
    expect(await codeOf(profiles.list(caller, "s1"))).toBe("helper_failed");
  });
});
