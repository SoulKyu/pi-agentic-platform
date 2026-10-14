import { realpathSync } from "node:fs";
import type { AlwaysScope } from "@pap/contracts";
import { expect, it, vi } from "vitest";
import { createIntBed, type IntBed, promptAndSettle, type Subscription } from "./testing/int-bed.ts";

// `make` is no read-only command and no Makefile is needed: the bash tool runs it and reports the failure, which is
// all the test needs (the rule decides whether a card comes, not what the command does).
// A relative PATH entry (pnpm adds `node_modules/.bin`) makes every command uncovered: the worker gets absolute ones.
const PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => entry.startsWith("/"))
  .join(":");
const bash = (command: string, id: string) => ({ toolCalls: [{ name: "bash", args: { command }, id }] });
const cards = (sub: Subscription) => sub.events().filter((event) => event.kind === "dialog_open");

async function answerCard(
  bed: IntBed,
  sub: Subscription,
  sessionId: string,
  index: number,
  response: { answer: "once" | "deny" | "always"; scope?: AlwaysScope },
) {
  await vi.waitFor(() => expect(cards(sub).length).toBeGreaterThan(index), { timeout: 20_000 });
  const card = cards(sub)[index];
  if (card?.kind !== "dialog_open") throw new Error("no card");
  await bed.rpc["sessions.respondDialog"]({ sessionId, dialogId: card.dialog.id, response }, bed.ctx);
  return card.dialog;
}
/** Prompts without waiting, and returns the wait for the run that prompt starts to be over. */
async function start(bed: IntBed, sub: Subscription, sessionId: string, text: string) {
  const before = sub.events().length;
  void bed.rpc["sessions.prompt"]({ sessionId, text }, bed.ctx).catch(() => {});
  return () =>
    vi.waitFor(
      () => {
        const statuses = sub
          .events()
          .slice(before)
          .flatMap((event) => (event.kind === "status" ? [event.status] : []));
        if (!statuses.includes("running") || statuses.lastIndexOf("idle") <= statuses.indexOf("running"))
          throw new Error("still running");
      },
      { timeout: 20_000 },
    );
}

it("an always/prefix answer runs the same prefix unasked, asks for another command, and a revoke asks again", async () => {
  const bed = await createIntBed(
    {
      steps: [
        bash("make build", "b1"),
        { text: "1" },
        bash("make build extra", "b2"),
        { text: "2" },
        bash("make clean", "b3"),
        { text: "3" },
        bash("make build again", "b4"),
        { text: "4" },
      ],
    },
    { path: PATH },
  );
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    const firstDone = await start(bed, sub, sessionId, "one");
    const card = await answerCard(bed, sub, sessionId, 0, { answer: "always", scope: "prefix" });
    expect(card.alwaysScopes).toEqual({ prefix: ["make", "build"] });
    await firstDone();
    await vi.waitFor(
      () =>
        expect(bed.policy.port.prefixesFor("u1", realpathSync(bed.work))).toEqual([
          { prefix: ["make", "build"] },
        ]),
      { timeout: 20_000 },
    );
    // The same prefix with more words runs with no card.
    await promptAndSettle(bed, sub, sessionId, "two");
    expect(cards(sub)).toHaveLength(1);
    // Another command of the same program asks.
    const thirdDone = await start(bed, sub, sessionId, "three");
    await answerCard(bed, sub, sessionId, 1, { answer: "deny" });
    await thirdDone();
    expect(cards(sub)).toHaveLength(2);
    // Revoking the rule reaches the live worker: the same prefix asks again.
    const listed = await bed.policy.rpc["policy.listRules"]({ cwd: bed.work }, bed.ctx);
    expect(listed.rules).toEqual([expect.objectContaining({ kind: "prefix", pattern: ["make", "build"] })]);
    await bed.policy.rpc["policy.revokeRule"]({ ruleId: listed.rules[0]?.id ?? "" }, bed.ctx);
    const fourthDone = await start(bed, sub, sessionId, "four");
    await answerCard(bed, sub, sessionId, 2, { answer: "deny" });
    await fourthDone();
    expect(cards(sub)).toHaveLength(3);
  } finally {
    await bed.dispose();
  }
}, 120_000);
