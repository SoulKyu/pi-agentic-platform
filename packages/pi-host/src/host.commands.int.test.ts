import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashScript, createHostBed, isConfirm } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

describe("session commands over IPC", () => {
  it("reports the leaf in ready and moves it with navigate_tree, so the next prompt branches", async () => {
    const ready = await bed.start({ steps: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    expect(ready.leafId).toEqual(expect.any(String));
    const host = bed.host();
    for (const text of ["first", "second"]) {
      const from = host.records.length;
      await host.request({ type: "prompt", message: text });
      await host.waitFor((r) => r.type === "agent_settled", { from });
    }
    // Pi emits no entry_appended for messages (message_end carries them): the file is the witness here.
    const file = String(ready.sessionFile);
    const entries = () =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { id: string; parentId: string | null; message?: { role: string } },
        );
    const firstReply = entries().find((entry) => entry.message?.role === "assistant");
    if (!firstReply) throw new Error("no assistant entry");
    const moved = await host.request({ type: "navigate_tree", targetId: firstReply.id });
    expect(moved).toMatchObject({ success: true, data: { cancelled: false, leafId: firstReply.id } });
    const before = entries().length;
    const from = host.records.length;
    await host.request({ type: "prompt", message: "third" });
    await host.waitFor((r) => r.type === "agent_settled", { from });
    // The new user message hangs under the first reply: a sibling of "second", in the same file.
    expect(
      entries()
        .slice(before)
        .find((entry) => entry.message?.role === "user")?.parentId,
    ).toBe(firstReply.id);
  });

  it("names, compacts and exports a session", async () => {
    await bed.start(
      {
        steps: [
          { text: "first reply" },
          { text: "second reply" },
          { text: "a summary of the session" },
          { text: "a summary of the turn prefix" },
        ],
      },
      { settings: { compaction: { keepRecentTokens: 1 } } },
    );
    const host = bed.host();
    for (const text of ["first", "second"]) {
      const from = host.records.length;
      await host.request({ type: "prompt", message: text });
      await host.waitFor((r) => r.type === "agent_settled", { from });
    }
    expect(await host.request({ type: "set_session_name", name: "Fix login" })).toMatchObject({
      success: true,
    });
    await host.waitFor((r) => r.type === "session_info_changed" && r.name === "Fix login");
    const compacted = await host.request({ type: "compact" });
    expect(compacted).toMatchObject({ success: true, data: { tokensBefore: expect.any(Number) } });
    await host.waitFor((r) => r.type === "compaction_end");
    const out = join(bed.papHome, "export.html");
    expect(await host.request({ type: "export_html", outputPath: out })).toMatchObject({
      success: true,
      data: { path: out },
    });
    expect(readFileSync(out, "utf8")).toContain("<html");
  });

  it("clears the steering queue of a run parked on an approval", async () => {
    await bed.start(bashScript("echo parked"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isConfirm);
    expect(
      await host.request({ type: "prompt", message: "go left instead", streamingBehavior: "steer" }),
    ).toMatchObject({ data: { disposition: "queued" } });
    await host.waitFor((r) => r.type === "queue_update" && r.count === 1);
    expect(await host.request({ type: "clear_queue" })).toMatchObject({
      data: { steering: ["go left instead"], followUp: [], truncated: false },
    });
    host.send({ type: "extension_ui_response", id: ask.id, cancelled: true });
    await host.waitFor((r) => r.type === "agent_settled");
  });
});

describe("auto_name over IPC", () => {
  it("names a session from its transcript through the scripted model", async () => {
    await bed.start({ steps: [{ text: "I will look at the login form." }, { text: "Fix the login bug" }] });
    const host = bed.host();
    await host.request({ type: "prompt", message: "the login button does nothing" });
    await host.waitFor((r) => r.type === "agent_settled");
    expect(await host.request({ type: "auto_name" })).toMatchObject({
      success: true,
      data: { title: "Fix the login bug" },
    });
    await host.waitFor((r) => r.type === "session_info_changed" && r.name === "Fix the login bug");
  });

  it("refuses to name a session nobody has spoken to", async () => {
    await bed.start({ steps: [{ text: "unused" }] });
    expect(await bed.host().request({ type: "auto_name" })).toMatchObject({
      success: false,
      error: "nothing to name",
    });
  });
});
