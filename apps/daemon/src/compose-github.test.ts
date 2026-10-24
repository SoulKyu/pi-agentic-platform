import { describe, expect, it } from "vitest";
import type { Caller } from "@pap/contracts";
import { githubSessionsPort } from "./compose-github.ts";

const caller = { userId: "u1" } as Caller;

describe("githubSessionsPort", () => {
  it("creates in the project's folder with no model, prompts, lists the owner's sessions and taints through the policy", async () => {
    const calls: unknown[][] = [];
    const port = githubSessionsPort(
      {
        lanes: {
          create: async (...args: unknown[]) => (
            calls.push(["create", ...args]),
            { sessionId: "s1", modelRefused: false }
          ),
          prompt: async (...args: unknown[]) => (
            calls.push(["prompt", ...args]),
            { disposition: "started" as const }
          ),
          sessionIdsIn: (...args: unknown[]) => (calls.push(["ids", ...args]), ["s1"]),
        },
      } as never,
      { markTainted: (...args: unknown[]) => (calls.push(["taint", ...args]), true) },
    );
    expect(await port.create(caller, "/boxes/p/project")).toMatchObject({ sessionId: "s1" });
    await port.prompt(caller, "s1", "hello");
    expect(port.sessionIdsIn("u1", "/boxes/p/project")).toEqual(["s1"]);
    port.markTainted("u1", "s1");
    expect(calls).toEqual([
      ["create", caller, "/boxes/p/project", null],
      ["prompt", caller, "s1", "hello"],
      ["ids", "u1", "/boxes/p/project"],
      ["taint", "u1", "s1"],
    ]);
  });
});
