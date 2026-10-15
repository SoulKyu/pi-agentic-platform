import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditView, EventFrame, LaneView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type OutwardBed, startOutwardBed } from "../modules/lanes/testing/outward-bed.ts";
import { createLaneAs, latest, ok, rewriteScript, TIMEOUT } from "./testing/lanes-bed.ts";

// Spec C §8.1, M9 (R97): in auto-accept-edits the agent edits its own lane without asking, and nothing else of pap's
// home: not a sibling lane, not pap's database, not the lane's project file, not pap's secrets (M5R29 unchanged).
let bed: OutwardBed;
let own: LaneView;
let sibling: LaneView;
beforeAll(async () => {
  bed = await startOutwardBed([{}], {}, { steps: [{ text: "ready" }], config: { maxWorkers: 8 } });
  const lanes: LaneView[] = [];
  for (const title of ["Sibling lane", "Own lane"]) {
    const [id] = await createLaneAs(bed.owner, bed, { title });
    await vi.waitFor(() => expect(latest(bed, id as string)?.primarySessionId).toBeTruthy(), {
      timeout: TIMEOUT,
    });
    lanes.push(latest(bed, id as string) as LaneView);
  }
  [sibling, own] = lanes as [LaneView, LaneView];
}, TIMEOUT);
afterAll(async () => {
  await bed?.stop();
});

const kindOf = (frame: EventFrame): string | undefined => (frame.event as { kind?: string }).kind;
const statusOf = (frame: EventFrame): string | undefined => (frame.event as { status?: string }).status;
type Card = { dialog: { id: string; message: string } };

describe("security: the lane policy, an agent in its own lane", () => {
  it(
    "runs a write in its lane without a card and asks for everything else of pap's home",
    async () => {
      const steps = [
        { toolCalls: [{ name: "write", args: { path: "src/a.ts", content: "ok\n" }, id: "own" }] },
        {
          toolCalls: [
            { name: "write", args: { path: `../${sibling.id}/a.ts`, content: "x" }, id: "sibling" },
          ],
        },
        {
          toolCalls: [
            { name: "write", args: { path: join(bed.t.home, "state.db"), content: "x" }, id: "db" },
          ],
        },
        { toolCalls: [{ name: "write", args: { path: ".pi/project.yaml", content: "x" }, id: "project" }] },
        {
          toolCalls: [{ name: "read", args: { path: join(bed.t.home, "secrets", "x") }, id: "secrets" }],
        },
        { text: "done" },
      ];
      rewriteScript(bed, steps);
      const session = await ok<{ sessionId: string }>(bed.owner, "lanes.newSession", { laneId: own.id });
      const sessionId = session.sessionId;
      const { sub } = await ok<{ sub: string }>(bed.owner, "subscribe.session", { sessionId });
      expect(
        await bed.owner.call("policy.setSessionMode", { sessionId, mode: "auto-accept-edits" }),
      ).toMatchObject({ ok: true });
      const mark = bed.owner.events.filter((frame) => frame.sub === sub).at(-1)?.seq ?? -1;
      expect(await bed.owner.call("sessions.prompt", { sessionId, text: "go" })).toMatchObject({ ok: true });

      let cursor = (
        await bed.owner.waitForEvent((f) => f.sub === sub && f.seq > mark && statusOf(f) === "running")
      ).seq;
      const cards: string[] = [];
      for (;;) {
        const next = await bed.owner.waitForEvent(
          (f) => f.sub === sub && f.seq > cursor && (kindOf(f) === "dialog_open" || statusOf(f) === "idle"),
        );
        cursor = next.seq;
        if (kindOf(next) !== "dialog_open") break;
        const { dialog } = next.event as unknown as Card;
        cards.push(dialog.message);
        // The write in the lane ran before the first card: the card for the next call is the first.
        if (cards.length === 1) {
          const written = join(own.worktree, "src", "a.ts");
          expect(
            existsSync(written),
            `a card asked for the write in the lane itself: ${dialog.message}`,
          ).toBe(true);
          expect(readFileSync(written, "utf8")).toBe("ok\n");
        }
        const answered = await bed.owner.call("sessions.respondDialog", {
          sessionId,
          dialogId: dialog.id,
          response: { answer: "deny" },
        });
        expect(answered).toMatchObject({ ok: true });
      }
      expect(cards).toHaveLength(4);
      for (const message of cards) expect(message).toMatch(/protected path|outside the session directory/);

      const audit = await ok<{ entries: AuditView[] }>(bed.owner, "audit.list", { sessionId, limit: 200 });
      const decisions = Object.fromEntries(
        audit.entries.filter((row) => row.kind === "call").map((row) => [row.toolCallId, row.decision]),
      );
      expect(decisions).toEqual({
        own: "allow",
        sibling: "denied",
        db: "denied",
        project: "denied",
        secrets: "denied",
      });
      expect(existsSync(join(sibling.worktree, "a.ts"))).toBe(false);
      expect(existsSync(join(own.worktree, ".pi", "project.yaml"))).toBe(false);
    },
    TIMEOUT,
  );
});
