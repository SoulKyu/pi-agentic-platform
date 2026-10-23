import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SessionStreamEvent } from "@pap/contracts";
import { expect, it, vi } from "vitest";
import { createIntBed, type IntBed, promptAndSettle, type Subscription } from "./testing/int-bed.ts";

const write = (path: string, id: string) => ({
  toolCalls: [{ name: "write", args: { path, content: "x" }, id }],
});
const bash = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });
// The grant-key helper repeats M2's encoding (M2R65) on purpose: a test must not import pi-host's code to compute what
// pi-host computes; `grant-key.test.ts` pins the encoding.
const keyOf = (command: string) =>
  createHash("sha256")
    .update(JSON.stringify(["bash", "cmd", command]))
    .digest("hex");

// A plain extension tool is external content for the policy (M5R39): its result taints the session.
const LOOKUP = `export default function (pi) {
  pi.registerTool({
    name: "lookup",
    label: "lookup",
    description: "looks something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "a reply from outside" }], details: {} }),
  });
}
`;

const idle = (sub: Subscription) =>
  vi.waitFor(
    () => {
      const statuses = sub.events().flatMap((event) => (event.kind === "status" ? [event.status] : []));
      if (!statuses.includes("running") || statuses.at(-1) !== "idle") throw new Error("still running");
    },
    { timeout: 20_000 },
  );

async function answerNext(bed: IntBed, sub: Subscription, sessionId: string, answer: "once" | "deny") {
  // The cards before this call were answered already: the next one is the one after them.
  const answered = sub.events().filter((event) => event.kind === "dialog_open").length;
  let ask: SessionStreamEvent | undefined;
  await vi.waitFor(
    () => {
      ask = sub.events().filter((event) => event.kind === "dialog_open")[answered];
      if (!ask) throw new Error("no card yet");
    },
    { timeout: 20_000 },
  );
  if (ask?.kind !== "dialog_open") throw new Error("no card");
  await bed.rpc["sessions.respondDialog"](
    { sessionId, dialogId: ask.dialog.id, response: { answer } },
    bed.ctx,
  );
  return ask.dialog;
}

it("a mode change bites the live worker: the next write is blocked in read-only, without a card", async () => {
  const bed = await createIntBed({
    steps: [write("a.txt", "w1"), { text: "1" }, write("b.txt", "w2"), { text: "2" }],
  });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "first");
    expect(existsSync(join(bed.work, "a.txt"))).toBe(true);
    await bed.policy.rpc["policy.setSessionMode"]({ sessionId, mode: "read-only" }, bed.ctx);
    expect(sub.events()).toContainEqual({
      kind: "policy",
      policy: { mode: "read-only", explicit: true, tainted: false, defaultMode: "auto-accept-edits" },
    });
    await promptAndSettle(bed, sub, sessionId, "second");
    expect(existsSync(join(bed.work, "b.txt"))).toBe(false);
    expect(sub.events().filter((event) => event.kind === "dialog_open")).toEqual([]);
    expect(
      bed
        .auditCalls()
        .filter((row) => row.tool === "write")
        .map((row) => row.decision),
    ).toEqual(["allow", "block"]);
  } finally {
    await bed.dispose();
  }
});

it("a taint stored while the session was cold reaches its next worker: a covered exfiltration call asks", async () => {
  const EXFIL = "env echo exfil";
  const bed = await createIntBed({ steps: [bash(EXFIL, "b"), { text: "after" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    bed.policy.port.addAlways({
      ownerId: "u1",
      scope: realpathSync(bed.work),
      tool: "bash",
      key: keyOf(EXFIL),
      label: EXFIL,
    });
    bed.killWorker(sessionId);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold");
    expect(bed.policy.port.markTainted("u1", sessionId)).toBe(true);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "go" }, bed.ctx).catch(() => {});
    const card = await answerNext(bed, sub, sessionId, "deny");
    expect(card).toMatchObject({ method: "approval", tainted: true, answers: ["deny", "once"] });
  } finally {
    await bed.dispose();
  }
});

it("a taint the worker reports is stored by the daemon and survives the worker: the next one starts tainted (M5R60)", async () => {
  const EXFIL = "env echo exfil";
  const bed = await createIntBed(
    {
      steps: [
        { toolCalls: [{ name: "lookup", args: { q: "x" }, id: "l1" }] },
        { text: "1" },
        bash(EXFIL, "b"),
        { text: "2" },
      ],
    },
    { extensions: { lookup: LOOKUP } },
  );
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    bed.policy.port.addAlways({
      ownerId: "u1",
      scope: realpathSync(bed.work),
      tool: "bash",
      key: keyOf(EXFIL),
      label: EXFIL,
    });
    void bed.rpc["sessions.prompt"]({ sessionId, text: "look" }, bed.ctx).catch(() => {});
    // The extension tool is not covered by a rule: it asks once, and its result taints the session.
    await answerNext(bed, sub, sessionId, "once");
    await vi.waitFor(
      () => expect(bed.policy.port.sessionPolicy("u1", sessionId).taint).toEqual({ tainted: true, epoch: 0 }),
      { timeout: 20_000 },
    );
    expect(sub.events()).toContainEqual({
      kind: "policy",
      policy: { mode: "auto-accept-edits", explicit: false, tainted: true, defaultMode: "auto-accept-edits" },
    });
    bed.killWorker(sessionId);
    await vi.waitFor(
      () => expect(sub.events().filter((e) => e.kind === "status" && e.status === "cold")).toHaveLength(1),
      { timeout: 20_000 },
    );
    void bed.rpc["sessions.prompt"]({ sessionId, text: "now" }, bed.ctx).catch(() => {});
    const card = await answerNext(bed, sub, sessionId, "deny");
    expect(card).toMatchObject({ method: "approval", tainted: true, answers: ["deny", "once"] });
  } finally {
    await bed.dispose();
  }
});

it("clearing the taint lowers it in the live worker and in the view, and the always rule applies again", async () => {
  const SAFE = "env echo safe";
  const bed = await createIntBed({
    steps: [bash(SAFE, "b1"), { text: "1" }, bash(SAFE, "b2"), { text: "2" }],
  });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    bed.policy.port.addAlways({
      ownerId: "u1",
      scope: realpathSync(bed.work),
      tool: "bash",
      key: keyOf(SAFE),
      label: SAFE,
    });
    bed.policy.port.markTainted("u1", sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "one" }, bed.ctx).catch(() => {});
    await answerNext(bed, sub, sessionId, "once");
    await idle(sub);
    await bed.policy.rpc["policy.clearTaint"]({ sessionId }, bed.ctx);
    expect(sub.events()).toContainEqual({
      kind: "policy",
      policy: {
        mode: "auto-accept-edits",
        explicit: false,
        tainted: false,
        defaultMode: "auto-accept-edits",
      },
    });
    await promptAndSettle(bed, sub, sessionId, "two");
    expect(sub.events().filter((event) => event.kind === "dialog_open")).toHaveLength(1);
  } finally {
    await bed.dispose();
  }
});
