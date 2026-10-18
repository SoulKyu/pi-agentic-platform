/// <reference lib="dom" />
// J07: an agent is created in the form, its thread is opened and prompted, the agent notifies the owner (an Inbox item and
// unread on the rail), the permissions sheet is read, and the owner quarantines it with the password step-up. From outside:
// the agent list says `quarantined` and paused, its thread (archived by the quarantine) has no worker, and the notice is
// one Inbox item of the agent.
import type { Page } from "@playwright/test";
import { expect, scripted, stepUp, t, test } from "./fixtures.ts";
import { bwrapUsable, dbRows, liveProcesses } from "./seed.ts";

const NOTE = "Scout checked in: the board is quiet.";

test.use({
  papScript: scripted([
    { toolCalls: [{ name: "agent_notify", id: "j07-notify", args: { text: NOTE } }] },
    { text: "I told the owner." },
  ]),
});

interface AgentRow {
  id: string;
  name: string;
  state: string;
  paused: boolean;
  quarantinedAt: number | null;
  threadSessionId: string | null;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rail = (page: Page) => page.getByRole("navigation", { name: t("shell.rail.label"), exact: true });
// Observed: 2 unread, the notice and then the agent's reply.
const unread = escape(t("shell.agent.unread", { count: 2 }));
const unreadScout = (page: Page) =>
  rail(page).getByRole("button", { name: new RegExp(`^Scout,.*${unread}`) });

test("J07: an agent notifies the owner and is quarantined", async ({ page, pap, signedIn }) => {
  await bwrapUsable(pap);
  const agents = async (): Promise<AgentRow[]> =>
    (await pap.rpc<{ agents: AgentRow[] }>("agents.list")).agents;
  const notices = async (): Promise<{ kind: string; agentId: string | null }[]> =>
    (await pap.rpc<{ items: { kind: string; agentId: string | null }[] }>("inbox.list", {})).items.filter(
      (item) => item.kind === "agent_notify",
    );
  await signedIn.goto(pap.origin);

  await test.step("create the agent in the form: sandbox on, default model", async () => {
    const dialog = page.getByRole("dialog", { name: t("agentForm.dialog.title"), exact: true });
    await rail(page)
      .getByRole("button", { name: t("shell.rail.newAgent"), exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(t("agentForm.name"), { exact: true }).fill("Scout");
    await dialog.getByRole("radio", { name: t("agentForm.sandbox.required"), exact: true }).click();
    await dialog.getByRole("button", { name: t("agentForm.create"), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Scout", exact: true })).toBeVisible();
  });

  await test.step("send the prompt in the agent's thread", async () => {
    await page.getByLabel(t("session.composer"), { exact: true }).fill("Check the board and tell me.");
    await page.getByRole("button", { name: t("sessions.composer.send"), exact: true }).click();
    await expect(page.getByRole("article", { name: t("author.you"), exact: true })).toHaveCount(1);
    // Leave the thread now: an open thread marks itself read after a second, and the rail must show the unread.
    // In the app (the pap mark of the rail), not a `goto` that would race the app's own navigation.
    await rail(page)
      .getByRole("link", { name: t("app.name"), exact: true })
      .click();
    await expect(page).toHaveURL(`${pap.origin}/`);
  });

  await test.step("the rail shows unread and the Inbox holds the notice", async () => {
    await expect(unreadScout(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await notices()).length).toBe(1);
    const drawer = page.getByRole("dialog", { name: t("shell.inbox.title"), exact: true });
    await page
      .getByRole("banner")
      .getByRole("button", { name: /^Inbox/ })
      .click();
    await expect(drawer).toBeVisible();
    const row = drawer.getByRole("button", {
      name: new RegExp(escape(t("inbox.agent.line.notify", { name: "Scout" }))),
    });
    await expect(row).toBeVisible();
    await expect(row.getByText(NOTE, { exact: true })).toBeVisible();
    // The row opens the agent's thread and closes the drawer.
    await row.click();
    await expect(page.getByLabel(t("session.composer"), { exact: true })).toBeVisible();
  });

  await test.step("open the permissions sheet from the agent's Settings tab", async () => {
    await page.getByRole("radio", { name: t("agentSafety.tab.settings"), exact: true }).click();
    const sheet = page.locator("[data-agent-permissions]");
    await expect(
      sheet.getByRole("heading", { name: t("agentSafety.perm.title"), exact: true }),
    ).toBeVisible();
    await expect(sheet.getByText(t("agentSafety.perm.sandbox.on"), { exact: true })).toBeVisible();
  });

  await test.step("the Settings tab has one vertical scroll container and no blank tail", async () => {
    const verticalScrollers = () =>
      page.evaluate(() => {
        const scrolls = (el: Element, overflowY: string, shown: number) =>
          el.scrollHeight > shown + 1 && (overflowY === "auto" || overflowY === "scroll");
        const found = [...document.querySelectorAll("body *")].filter((el) =>
          scrolls(el, getComputedStyle(el).overflowY, el.clientHeight),
        );
        // The document scrolls on its own when something escapes the clipping containers (an unpositioned hidden input).
        const root = document.scrollingElement ?? document.documentElement;
        return { elements: found.length, documentScrolls: root.scrollHeight > window.innerHeight + 1 };
      });
    await expect.poll(verticalScrollers).toEqual({ elements: 1, documentScrolls: false });
    const actions = page.locator("[data-agent-actions]");
    await actions.scrollIntoViewIfNeeded();
    const last = actions.getByRole("button", { name: t("agentSafety.actions.delete"), exact: true });
    await last.scrollIntoViewIfNeeded();
    const viewport = page.viewportSize()?.height ?? 0;
    const box = await last.boundingBox();
    expect(box && box.y + box.height <= viewport + 1).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  const threadId = (await agents()).find((agent) => agent.name === "Scout")?.threadSessionId ?? "";
  expect(threadId).not.toBe("");
  const withThread = liveProcesses(pap); // the daemon and the thread's worker

  await test.step("quarantine with the password step-up", async () => {
    await stepUp(page, pap);
    await page.getByRole("button", { name: t("agentSafety.actions.quarantine"), exact: true }).click();
    const ask = page.getByRole("dialog", { name: t("agentSafety.q.title", { name: "Scout" }), exact: true });
    await ask.getByRole("button", { name: t("agentSafety.q.continue"), exact: true }).click();
    await ask
      .getByRole("button", { name: t("agentSafety.q.confirm", { name: "Scout" }), exact: true })
      .click();
    const done = page.getByRole("dialog", {
      name: t("agentSafety.q.doneTitle", { name: "Scout" }),
      exact: true,
    });
    await done.getByRole("button", { name: t("agentSafety.q.done"), exact: true }).click();
    await expect(
      rail(page).getByRole("button", { name: new RegExp(`^Scout, ${t("shell.agent.state.quarantined")}`) }),
    ).toBeVisible();
  });

  // From outside: quarantined and paused; the thread was archived and its worker is gone; one notice, the agent's.
  const scout = (await agents()).find((agent) => agent.name === "Scout");
  expect(scout).toMatchObject({ state: "quarantined", paused: true, threadSessionId: null });
  expect(scout?.quarantinedAt).toEqual(expect.any(Number));
  expect(
    dbRows<{ archived_at: number | null }>(pap, "SELECT archived_at FROM sessions WHERE id = ?", threadId),
  ).toEqual([{ archived_at: expect.any(Number) }]);
  await expect.poll(() => liveProcesses(pap)).toBeLessThan(withThread);
  expect((await notices()).map((item) => item.agentId)).toEqual([scout?.id]);
});
