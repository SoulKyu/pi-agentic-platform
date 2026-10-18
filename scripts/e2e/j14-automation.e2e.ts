// J14: a schedule trigger is created from the form (RRULE and a time zone), the dry-run and the preview show what it would do,
// "Fire now" runs a task that lands in the Inbox, and pausing automation in Settings makes the next manual fire refuse with
// the catalog's sentence and start nothing. Resuming lets the next fire through. From outside: task rows, the trigger's
// journal (the refusal has a closed verdict), the stored setting and no process left behind by a finished task.
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, stepUp, t, test } from "./fixtures.ts";
import type { PapInstance } from "./fixtures.ts";
import { actUntilVisible, dbRows, liveProcesses } from "./seed.ts";

test.use({ papScript: scripted([{ text: "Disk check done." }]) });

const NAME = "Morning disk check";
const PROMPT = "Check the disk and report.";
const ZONE = "Asia/Tokyo"; // no daylight saving: 09:00 there is the same instant all year
const RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Fire {
  verdict: string;
  source: string;
  taskId: string | null;
  taskState: string | null;
}
interface TriggerRow {
  id: string;
  name: string;
  enabled: boolean;
  nextFireAt: number | null;
  source: { type: string; rrule?: string; timezone?: string } | null;
}

// Only the manual fires of this journey: a scheduled fire of the real clock is not ours and must not move an assertion.
const journal = async (pap: PapInstance, triggerId: string): Promise<Fire[]> =>
  (await pap.rpc<{ entries: Fire[] }>("automation.journal", { triggerId })).entries.filter(
    (entry) => entry.source === "manual",
  );
const taskRows = (pap: PapInstance) =>
  dbRows<{ id: string; origin: string; state: string }>(
    pap,
    "SELECT id, origin, state FROM tasks WHERE origin = 'manual' ORDER BY rowid",
  );
const hourIn = (at: number, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

const pauseSwitch = (page: Page) =>
  page.getByRole("switch", { name: t("settingsAutomation.pause.label"), exact: true });
const fireNow = (page: Page) =>
  page.getByRole("button", { name: t("automation.editor.fireNow"), exact: true });

async function setPaused(page: Page, pap: PapInstance, paused: boolean): Promise<void> {
  await page.goto(`${pap.origin}/settings/automation`);
  const toggle = pauseSwitch(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked({ checked: paused });
  await toggle.click();
  if (paused) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await pap.rpc<{ value: { paused?: boolean } | null }>("settings.get", { key: "automation" })).value
          ?.paused ?? false,
    )
    .toBe(paused);
}

test("J14: a schedule trigger fires into the Inbox, a paused automation refuses the next fire", async ({
  page,
  pap,
  signedIn,
}) => {
  const idleProcesses = liveProcesses(pap);

  await test.step("create a schedule trigger from the form, with an RRULE and a time zone", async () => {
    await signedIn.goto(pap.origin);
    await page.getByRole("radio", { name: t("launch.mode.trigger"), exact: true }).click();
    await page.getByLabel(t("launch.field"), { exact: true }).fill(NAME);
    await page.getByRole("button", { name: t("launch.go.trigger"), exact: true }).click();
    await page.getByRole("button", { name: basename(pap.work), exact: true }).click();

    await page.getByLabel(t("automation.editor.name"), { exact: true }).fill(NAME);
    await page.getByLabel(t("automation.editor.prompt"), { exact: true }).fill(PROMPT);
    await page.getByLabel(t("automation.editor.schedule.rrule"), { exact: true }).fill(RRULE);
    // The list is every zone of the browser: typing the name selects it (a click would fight the list's scroll arrows).
    const zone = page.getByRole("combobox", { name: t("automation.editor.schedule.timezone"), exact: true });
    await zone.click();
    await page.keyboard.type(ZONE, { delay: 40 });
    await expect(page.getByRole("option", { name: ZONE, exact: true })).toHaveAttribute(
      "data-highlighted",
      "",
    );
    await page.keyboard.press("Enter");
    await expect(zone).toHaveText(ZONE);
    await page.getByRole("switch", { name: t("automation.editor.enabled"), exact: true }).click();
    await expect(
      page.getByText(t("automation.editor.schedule.next", { zone: ZONE }), { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="next-fires"] li')).toHaveCount(5);
  });

  await test.step("the dry-run says it would fire, and writes nothing", async () => {
    await page.getByRole("button", { name: t("automation.dry.run"), exact: true }).click();
    await expect(page.locator('[data-slot="dry-run-verdict"]')).toContainText(
      t("automation.dry.verdictFire"),
    );
  });
  expect(taskRows(pap)).toEqual([]);

  await test.step("Save with the step-up", async () => {
    await stepUp(page, pap);
    await page.getByRole("button", { name: t("automation.editor.save"), exact: true }).click();
    // A saved schedule trigger swaps the draft for the saved one at once: the daemon's list is what proves the save.
    await expect
      .poll(
        async () => (await pap.rpc<{ triggers: TriggerRow[] }>("automation.triggers.list")).triggers.length,
      )
      .toBe(1);
  });
  const { triggers } = await pap.rpc<{ triggers: TriggerRow[] }>("automation.triggers.list");
  const saved = triggers.find((trigger) => trigger.name === NAME);
  if (!saved) throw new Error("the saved trigger is not listed");
  expect(saved.source).toMatchObject({ type: "schedule", rrule: RRULE, timezone: ZONE });
  expect(saved.enabled).toBe(true);
  // The next fire is 09:00 in the chosen zone, whatever the zone of this machine.
  expect(saved.nextFireAt).not.toBeNull();
  expect(hourIn(saved.nextFireAt ?? 0, ZONE)).toBe("09:00");
  const dry = await pap.rpc<{ verdict: string; reasons: string[] }>("automation.dryRun", {
    triggerId: saved.id,
  });
  expect(dry).toMatchObject({ verdict: "fire", reasons: [] });

  await test.step("Fire now runs a task, the Inbox lists it", async () => {
    await page.goto(`${pap.origin}/trigger/${saved.id}`);
    await expect(fireNow(page)).toBeEnabled();
    await fireNow(page).click();
    await expect(page.getByText(t("automation.editor.fired"), { exact: true })).toBeVisible();
    // The task ends while the page rerenders: the rail button is "Inbox" first and "Inbox: unread items" after, and a click
    // that lands in between is dropped. Wait for the end, then open the Inbox until its row shows.
    await expect.poll(() => taskRows(pap).map((task) => task.state)).toEqual(["done"]);
    const inbox = page.getByRole("button", { name: new RegExp(`^${escape(t("shell.top.inbox"))}`) });
    const row = page.getByRole("button", {
      name: new RegExp(`^${escape(t("inbox.title.done", { name: NAME }))}`),
    });
    await actUntilVisible(() => inbox.click(), row);
    await expect(row).toBeVisible();
  });
  await expect
    .poll(() => taskRows(pap).map((task) => [task.origin, task.state]))
    .toEqual([["manual", "done"]]);
  const [first] = await journal(pap, saved.id);
  expect(first).toMatchObject({ verdict: "fired", source: "manual", taskState: "done" });
  expect(first?.taskId).toBe(taskRows(pap)[0]?.id);
  // A finished task leaves no worker of its own running (the idle count is the daemon's, as before the task).
  await expect.poll(() => liveProcesses(pap)).toBe(idleProcesses);

  await test.step("pause automation in Settings: the next manual fire is refused and nothing starts", async () => {
    await setPaused(page, pap, true);
    await page.goto(`${pap.origin}/trigger/${saved.id}`);
    await expect(fireNow(page)).toBeEnabled();
    await fireNow(page).click();
    await expect(page.getByRole("alert").filter({ hasText: t("error.automation_paused") })).toBeVisible();
  });
  expect(taskRows(pap)).toHaveLength(1);
  const refused = (await journal(pap, saved.id)).find((entry) => entry.verdict === "paused");
  expect(refused).toMatchObject({ verdict: "paused", source: "manual", taskId: null });

  await test.step("resume: the next fire starts a second task", async () => {
    await setPaused(page, pap, false);
    await page.goto(`${pap.origin}/trigger/${saved.id}`);
    await expect(fireNow(page)).toBeEnabled();
    await fireNow(page).click();
    await expect(page.getByText(t("automation.editor.fired"), { exact: true })).toBeVisible();
  });
  await expect.poll(() => taskRows(pap).map((task) => task.state)).toEqual(["done", "done"]);
  expect((await journal(pap, saved.id)).map((entry) => entry.verdict).sort()).toEqual([
    "fired",
    "fired",
    "paused",
  ]);
});
