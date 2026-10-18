// J08: a parent session starts two subagents whose commands wait for the owner. The subagent bar shows both, the project
// tree nests them under the parent (opened with the tree chord), Stop on the parent cancels both and leaves no worker; a
// second parent whose children are allowed once rolls their cost up: the chips, the state file and usage.summary agree.
// Each phase writes the script of the worker that starts next (a worker reads it once, when it starts).
import type { Page } from "@playwright/test";
import { chord, expect, plural, scripted, t, test } from "./fixtures.ts";
import { dbRows, liveProcesses, writeScript } from "./seed.ts";
import type { PapInstance } from "./fixtures.ts";

const CHILD_TEXT = "CHILD-ANSWER-e2e8";
// Dollars per million tokens: 10 000 makes every token one cent, so a cost is a whole number of cents.
const PRICES = { input: 10_000, output: 10_000 };
const spawn = (id: string, task: string) => ({ name: "subagent", args: { task }, id });
const PARENT = [
  { toolCalls: [spawn("sa1", "First look"), spawn("sa2", "Second look")] },
  { text: "Parent done." },
];
const CHILD = [
  { toolCalls: [{ name: "bash", id: "child-bash", args: { command: "env echo e2e-j08-child" } }] },
  { text: CHILD_TEXT },
];

test.use({ papScript: scripted([{ text: "unused" }]) });

const bar = (page: Page) => page.getByRole("region", { name: t("subagents.bar.label"), exact: true });
const cardsOf = (page: Page) => page.getByRole("alertdialog");

/** A parent session with two children, both waiting for an answer. Returns the parent's id and the process count before them. */
async function parentWithTwoChildren(
  page: Page,
  pap: PapInstance,
): Promise<{ parent: string; withoutChildren: number }> {
  writeScript(pap, PARENT, PRICES);
  const { sessionId: parent } = await pap.rpc<{ sessionId: string }>("sessions.create", { cwd: pap.work });
  await expect
    .poll(async () => {
      const { sessions } = await pap.rpc<{ sessions: { id: string; status: string }[] }>("sessions.list");
      return sessions.find((session) => session.id === parent)?.status;
    })
    .toBe("idle");
  // The parent's worker has read its script: the next two workers are the children's.
  writeScript(pap, CHILD, PRICES);
  const withoutChildren = liveProcesses(pap);
  await page.goto(`${pap.origin}/s/${parent}`);
  await page.getByLabel(t("session.composer"), { exact: true }).fill("Delegate two looks.");
  await page.getByRole("button", { name: t("sessions.composer.send"), exact: true }).click();
  await expect(bar(page).locator("[data-subagent]")).toHaveCount(2);
  await expect(cardsOf(page)).toHaveCount(2);
  return { parent, withoutChildren };
}

test("J08: Stop on the parent cancels both subagents and leaves no worker", async ({
  page,
  pap,
  signedIn,
}) => {
  await signedIn.goto(pap.origin);
  const { parent, withoutChildren } = await parentWithTwoChildren(page, pap);
  expect(liveProcesses(pap)).toBeGreaterThan(withoutChildren);

  await test.step("the tree nests both children under the parent", async () => {
    await chord(page, "b");
    const toggle = page.getByRole("button", {
      name: plural("subagents.bar.count", 2, { count: 2 }),
      exact: true,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("li:has([data-subagents-toggle]) ul a")).toHaveCount(2);
    await chord(page, "b");
  });

  await test.step("Stop on the parent closes both", async () => {
    await page.getByRole("button", { name: t("sessions.composer.stop"), exact: true }).click();
    await expect(bar(page).getByText(t("subagents.state.cancelled"), { exact: true })).toHaveCount(2);
    await expect(cardsOf(page)).toHaveCount(0);
  });

  // From outside: both runs ended cancelled with the owner's reason, their runs too, and no process is left for them.
  await expect
    .poll(() =>
      dbRows<{ state: string; reason: string | null }>(
        pap,
        "SELECT state, reason FROM subagent_runs WHERE parent_session_id = ?",
        parent,
      ).map((run) => [run.state, run.reason]),
    )
    .toEqual([
      ["cancelled", "stopped"],
      ["cancelled", "stopped"],
    ]);
  // The runs ledger is written apart from the subagent rows and can lag them: poll it too.
  await expect
    .poll(() =>
      dbRows<{ status: string }>(
        pap,
        "SELECT status FROM runs WHERE parent_session_id = ? AND origin = 'subagent'",
        parent,
      ).map((run) => run.status),
    )
    .toEqual(["cancelled", "cancelled"]);
  await expect.poll(() => liveProcesses(pap)).toBeLessThanOrEqual(withoutChildren);
});

test("J08: the parent's cost rolls up its children's", async ({ page, pap, signedIn }) => {
  await signedIn.goto(pap.origin);
  const summary = async () =>
    pap.rpc<{ totals: { costUsd: number }; byOrigin: { origin: string; costUsd: number }[] }>(
      "usage.summary",
      { range: "today" },
    );
  const before = await summary();
  const { parent } = await parentWithTwoChildren(page, pap);

  await test.step("allow both commands once; the children answer and the parent finishes", async () => {
    for (let left = 2; left > 0; left -= 1) {
      await expect(cardsOf(page)).toHaveCount(left);
      await cardsOf(page)
        .first()
        .getByRole("button", { name: t("dialog.answer.once"), exact: true })
        .click();
    }
    await expect(bar(page).getByText(t("subagents.state.done"), { exact: true })).toHaveCount(2);
    await expect(page.getByText("Parent done.", { exact: true })).toBeVisible();
  });

  // The numbers: what each chip shows, in cents; what the state file holds; what usage.summary adds up.
  const shown = await bar(page)
    .locator("[data-subagent]")
    .evaluateAll((items) => items.map((item) => item.textContent?.match(/\$(\d+\.\d\d)/)?.[1] ?? "none"));
  expect(shown).toHaveLength(2);
  const shownCents = shown.reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0);
  const cost = (sql: string): number => dbRows<{ usd: number | null }>(pap, sql, parent)[0]?.usd ?? 0;
  const own = cost("SELECT SUM(cost_usd) AS usd FROM runs WHERE session_id = ?");
  const children = cost("SELECT SUM(cost_usd) AS usd FROM runs WHERE parent_session_id = ?");
  expect(own).toBeGreaterThan(0);
  expect(shownCents).toBeGreaterThan(0);
  expect(shownCents).toBe(Math.round(children * 100));

  const after = await summary();
  const added = (origin: string): number =>
    (after.byOrigin.find((row) => row.origin === origin)?.costUsd ?? 0) -
    (before.byOrigin.find((row) => row.origin === origin)?.costUsd ?? 0);
  expect(added("subagent")).toBeCloseTo(children, 6);
  expect(after.totals.costUsd - before.totals.costUsd).toBeCloseTo(own + children, 6);
});
