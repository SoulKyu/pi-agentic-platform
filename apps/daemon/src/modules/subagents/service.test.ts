import { describe, expect, it } from "vitest";
import { bed as makeBed, type Options, settle } from "./testing/service-bed.ts";
import { createSubagentService, SUBAGENT_ANSWER_CHARS } from "./service.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";

const bed = (options?: Options) =>
  makeBed({ createSubagentService, createSubagentStop, createSubagentStore }, options);

describe("subagent.run (M11R137)", () => {
  it("makes a child, prompts it with the task, and returns its last text with the child's id", async () => {
    const b = bed();
    const call = b.service.run({ task: "Find the bug" }, b.ctx());
    await settle();
    expect(b.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({
      ownerId: "u1",
      sessionId: "child-1",
      text: "Find the bug",
    });
    b.finish("child-1");
    expect(await call).toEqual({ childId: "child-1", answer: "the answer", clipped: false, tainted: false });
    expect(b.store.get("id-1")).toMatchObject({
      state: "done",
      childSessionId: "child-1",
      parentSessionId: "parent",
      profile: null,
      title: "Find the bug",
    });
  });

  it("passes the profile's own words to the child, and keeps its name on the row", async () => {
    const b = bed();
    const call = b.service.run({ task: "t", profile: "scout" }, b.ctx());
    await settle();
    expect(b.profiles.get).toHaveBeenCalledWith("u1", "parent", "scout");
    expect(b.calls.find(([name]) => name === "createChild")?.[1]).toMatchObject({
      ownerId: "u1",
      parentSessionId: "parent",
      profile: { tools: ["read", "grep"], prompt: "You scout.", model: "fast" },
    });
    b.finish("child-1");
    await call;
    expect(b.store.get("id-1")?.profile).toBe("scout");
  });

  it("sets the row starting, then running with the child, then done", async () => {
    const b = bed();
    const seen: string[] = [];
    b.sessions.createChild.mockImplementationOnce(async () => {
      seen.push(b.store.get("id-1")?.state ?? "none");
      return { sessionId: "child-1", tainted: false };
    });
    b.sessions.prompt.mockImplementationOnce(async () => {
      seen.push(b.store.get("id-1")?.state ?? "none");
      return "started" as const;
    });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    expect(seen).toEqual(["starting", "running"]);
  });

  it("tags the child's runs with the subagent origin and the parent's task, before the prompt", async () => {
    const b = bed({ parentTaskId: "task-9" });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(
      b.calls.map(([name]) => name).filter((name) => name === "expectOrigin" || name === "prompt"),
    ).toEqual(["expectOrigin", "prompt"]);
    expect(b.runs.expectOrigin).toHaveBeenCalledWith("child-1", { origin: "subagent", taskId: "task-9" });
    b.finish("child-1");
    await call;
  });

  it("carries no task id when the parent's run is not a task's", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.runs.expectOrigin).toHaveBeenCalledWith("child-1", { origin: "subagent", taskId: null });
    b.finish("child-1");
    await call;
  });

  it("fences the task as subagent-task when the parent is tainted, and not otherwise", async () => {
    const b = bed();
    const call = b.service.run({ task: "do <b>x</b>" }, b.ctx({ tainted: true }));
    await settle();
    const text = (b.calls.find(([name]) => name === "prompt")?.[1] as { text: string }).text;
    expect(text).toContain('<untrusted source="subagent-task" id="id-');
    expect(text).toContain("do <b>x</b>");
    b.finish("child-1");
    await call;
  });

  it("returns the child's taint at the end, not the taint it started with", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.sessions.taintedOf.mockReturnValue(true);
    b.finish("child-1");
    expect(await call).toMatchObject({ tainted: true });
  });

  it("clips an answer past 50 KiB and says so", async () => {
    const b = bed({ text: "a".repeat(SUBAGENT_ANSWER_CHARS + 500) });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    const result = await call;
    expect(result.answer).toHaveLength(SUBAGENT_ANSWER_CHARS);
    expect(result.clipped).toBe(true);
    const exact = bed({ text: "b".repeat(SUBAGENT_ANSWER_CHARS) });
    const second = exact.service.run({ task: "t" }, exact.ctx());
    await settle();
    exact.finish("child-1");
    expect(await second).toMatchObject({ clipped: false });
  });

  it("answers an empty text when the child said nothing", async () => {
    const b = bed({ text: null });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    expect(await call).toMatchObject({ answer: "", clipped: false });
  });

  it("ignores the run end of another session", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("someone-else");
    await settle();
    expect(b.store.get("id-1")?.state).toBe("running");
    b.finish("child-1");
    await call;
  });

  it("stops listening once the run ended", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.listeners.size).toBe(1);
    b.finish("child-1");
    await call;
    expect(b.listeners.size).toBe(0);
  });
});
