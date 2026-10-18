// J09: two facts an untrusted run staged wait for review. The review tick (30 s of real time, the daemon uses the real clock)
// raises one Inbox item per fact; Settings › Memory lists both under "To review"; the owner approves one and rejects the
// other, then forgets an older memory. pi-mem0 is not installed in the e2e daemon, so the journey plays its watcher with
// seed.ts: what pap WRITES (decision and forget request files) is checked from outside, what pi-mem0 would do next is
// applied by the helper and read back through the UI and the RPC.
import type { Page } from "@playwright/test";
import { expect, t, test } from "./fixtures.ts";
import {
  agentMemories,
  applyDecisions,
  applyForgets,
  decisionOf,
  requestsOf,
  seedMemory,
  seedStagedMemory,
  stagingFiles,
} from "./seed.ts";

const KEEP = "Scout prefers weekly summaries on Fridays";
const DROP = "Scout was told the deploy key lives in a shared note";
const OLD = "Scout once asked for tea";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fact = (page: Page, text: string) =>
  page.locator("[data-fact-id]").filter({ has: page.getByText(text, { exact: true }) });

test("J09: staged memories wait for review, one is approved, one is rejected, one is forgotten", async ({
  page,
  pap,
  signedIn,
}) => {
  test.setTimeout(90_000); // M13R43: the review tick is 30 s of real time

  const { id: agentId } = await pap.rpc<{ id: string }>("agents.create", { input: { name: "Scout" } });
  seedMemory(pap, agentId, { id: "mem-old", text: OLD, source: "memory_save" });
  const keepId = seedStagedMemory(pap, agentId, KEEP);
  const dropId = seedStagedMemory(pap, agentId, DROP);
  expect(stagingFiles(pap)).toEqual([`${dropId}.json`, `${keepId}.json`].toSorted());

  await signedIn.goto(pap.origin);
  const line = t("inbox.agent.line.memory", { name: "Scout" });

  await test.step("the review tick raises one Inbox item per fact", async () => {
    await expect
      .poll(
        async () => {
          const { items } = await pap.rpc<{ items: { kind: string; agentId: string | null }[] }>(
            "inbox.list",
            {},
          );
          return items.filter((item) => item.kind === "memory_review" && item.agentId === agentId).length;
        },
        { timeout: 45_000, intervals: [1_000] },
      )
      .toBe(2);
    const drawer = page.getByRole("dialog", { name: t("shell.inbox.title"), exact: true });
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^Inbox/ })
      .click();
    await expect(drawer).toBeVisible();
    const rows = page.getByRole("button", { name: new RegExp(escape(line)) });
    await expect(rows).toHaveCount(2);
    // The Inbox row carries no fact text (W5-R61): it opens Settings › Memory, where the owner decides.
    await expect(page.getByText(KEEP)).toHaveCount(0);
    await rows.first().click();
    await expect(page.getByRole("heading", { name: t("memory.review.title"), exact: true })).toBeVisible();
  });

  await test.step("Settings › Memory lists both facts fenced under To review", async () => {
    for (const text of [KEEP, DROP]) {
      const row = fact(page, text);
      await expect(row).toBeVisible();
      await expect(row.getByText(t("memory.review.fence"), { exact: true })).toBeVisible();
      await expect(row.getByText(t("memory.review.from", { name: "Scout" }), { exact: true })).toBeVisible();
    }
  });

  await test.step("approve one, reject the other", async () => {
    await fact(page, KEEP)
      .getByRole("button", { name: t("memory.review.approve"), exact: true })
      .click();
    await expect(fact(page, KEEP).getByText(t("memory.review.waiting"), { exact: true })).toBeVisible();
    await fact(page, DROP)
      .getByRole("button", { name: t("memory.review.reject"), exact: true })
      .click();
    await expect(fact(page, DROP).getByText(t("memory.review.waiting"), { exact: true })).toBeVisible();
  });
  // From outside: pap wrote one decision file per fact and touched nothing else.
  expect(decisionOf(pap, keepId)).toEqual({ approved: true });
  expect(decisionOf(pap, dropId)).toEqual({ approved: false });
  expect(stagingFiles(pap)).toHaveLength(4);

  // pi-mem0 would claim the decisions now: the approved fact becomes a memory of the agent, the rejected one is dropped.
  applyDecisions(pap);
  expect(stagingFiles(pap)).toEqual([]);
  const staged = await pap.rpc<{ facts: unknown[] }>("memory.staged", {});
  expect(staged.facts).toEqual([]);

  await test.step("the approved fact is listed with the fixed source label, an older memory is forgotten", async () => {
    await page.goto(`${pap.origin}/settings/memory`);
    await expect(page.getByRole("heading", { name: t("memory.review.title"), exact: true })).toBeHidden();
    await page.getByRole("combobox", { name: t("memory.scope"), exact: true }).click();
    await page.getByRole("option", { name: t("memory.scope.agent", { name: "Scout" }), exact: true }).click();
    const list = page.getByRole("region", { name: t("memory.list.title"), exact: true });
    const kept = list.locator("[data-memory-id]").filter({ hasText: KEEP });
    await expect(kept).toBeVisible();
    await expect(kept.getByText(t("memory.source.staged"), { exact: true })).toBeVisible();
    const old = list.locator("[data-memory-id]").filter({ hasText: OLD });
    await expect(old.getByText(t("memory.source.memory_save"), { exact: true })).toBeVisible();

    await old.getByRole("checkbox", { name: OLD, exact: true }).check();
    await list.getByRole("button", { name: t("memory.forget.some", { n: 1 }), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("memory.forget.title"), exact: true });
    await dialog.getByRole("button", { name: t("memory.forget.one"), exact: true }).click();
    await expect(page.getByText(t("memory.forget.sent"), { exact: true })).toBeVisible();
  });
  expect(requestsOf(pap, "forget")).toEqual([{ memoryId: "mem-old", scope: `agent:${agentId}` }]);
  applyForgets(pap);

  // Durable state: the agent's memory file holds the approved fact only, with source `staged`; the staging folder is empty.
  const memories = agentMemories(pap, agentId);
  expect(memories.map((memory) => [memory.text, memory.source])).toEqual([[KEEP, "staged"]]);
  const listed = await pap.rpc<{ items: { text: string; source: string | null }[] }>("memory.list", {
    scope: { kind: "agent", id: agentId },
  });
  expect(listed.items.map((item) => [item.text, item.source])).toEqual([[KEEP, "staged"]]);
  expect(stagingFiles(pap)).toEqual([]);
});
