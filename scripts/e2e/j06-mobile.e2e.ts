/// <reference lib="dom" />
// J06: the phone shell (M13R40, phone projects only). The sessions list opens from the bottom bar and closes again, the
// composer is reachable, the approval card is as wide as the screen, primary buttons are touch-sized, a tap opens the session
// menu, and no screen scrolls sideways (the home, a session, Settings).
import { basename } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";
import { actUntilVisible } from "./seed.ts";

const MARKER = "e2e-j06-ok";
const TOUCH = 44;

test.use({
  papScript: scripted([
    { toolCalls: [{ name: "bash", id: "j06-bash", args: { command: `env echo ${MARKER}` } }] },
    { text: `The command printed ${MARKER}.` },
  ]),
});

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: t("shell.mobile.sections"), exact: true }).getByRole("button", {
    name,
    exact: true,
  });
const noSidewaysScroll = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("the element has no box");
  return found;
};
const touchSized = async (locator: Locator) => {
  const { width, height } = await box(locator);
  // 44 css px, less the rounding of a fractional layout.
  expect(width).toBeGreaterThanOrEqual(TOUCH - 0.5);
  expect(height).toBeGreaterThanOrEqual(TOUCH - 0.5);
};

test("J06: the phone shell", async ({ page, pap, signedIn }) => {
  await signedIn.goto(pap.origin);
  const field = page.getByLabel(t("launch.field"), { exact: true });
  const launch = page.getByRole("button", { name: t("launch.go.session"), exact: true });

  await test.step("the home fits the screen and its composer and primary button are reachable", async () => {
    await expect(field).toBeVisible();
    await noSidewaysScroll(page);
    await field.scrollIntoViewIfNeeded();
    const viewport = page.viewportSize();
    const typing = await box(field);
    expect(typing.x).toBeGreaterThanOrEqual(0);
    expect(typing.x + typing.width).toBeLessThanOrEqual(viewport?.width ?? 0);
    await touchSized(launch);
  });

  await test.step("the sessions list opens from the bottom bar and closes again", async () => {
    const lists = nav(page, t("shell.mobile.lists"));
    await lists.tap();
    await expect(lists).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: t("shell.mobile.more"), exact: true })).toBeVisible();
    await noSidewaysScroll(page);
    await nav(page, t("shell.mobile.work")).tap();
    await expect(lists).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: t("shell.mobile.more"), exact: true })).toBeHidden();
  });

  await test.step("launch a session; the approval card is as wide as the screen", async () => {
    await field.fill("Run the command");
    await launch.tap();
    await page.getByRole("button", { name: basename(pap.work), exact: true }).tap();
    const card = page.getByRole("alertdialog", {
      name: `${t("dialog.approval")} ${t("dialog.category.exec")}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    const viewport = page.viewportSize()?.width ?? 0;
    const { width } = await box(card);
    // The card fills the pane between the page's gutters; a card that kept its desktop width would be far narrower.
    expect(width).toBeGreaterThanOrEqual(viewport - 2 * 16);
    const once = card.getByRole("button", { name: t("dialog.answer.once"), exact: true });
    await touchSized(once);
    // The wide variant lays the answers in two columns: each button takes about half of the card, not its own text width.
    expect((await box(once)).width).toBeGreaterThanOrEqual(viewport * 0.4);
    await noSidewaysScroll(page);
    await once.tap();
    await expect(page.getByText(`The command printed ${MARKER}.`, { exact: true })).toBeVisible();
  });

  await test.step("the composer of the session is reachable and nothing scrolls sideways", async () => {
    const composer = page.getByLabel(t("session.composer"), { exact: true });
    await composer.scrollIntoViewIfNeeded();
    const { y, height } = await box(composer);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y + height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
    await noSidewaysScroll(page);
  });

  await test.step("a tap opens the session menu: no affordance waits for a hover", async () => {
    await nav(page, t("shell.mobile.lists")).tap();
    const menu = page.getByRole("button", { name: t("sidebar.menu.session"), exact: true });
    await touchSized(menu);
    await menu.tap();
    // On a phone the menu is a sheet of touch-sized buttons.
    const sheet = page.getByRole("dialog", { name: t("sidebar.menu.session"), exact: true });
    const pin = sheet.getByRole("button", { name: t("sidebar.action.pin"), exact: true });
    await expect(pin).toBeVisible();
    await touchSized(pin);
    await sheet.getByRole("button", { name: t("ui.close"), exact: true }).tap();
    await expect(sheet).toBeHidden();
  });

  await test.step("Settings fits the screen", async () => {
    const sheet = page.getByRole("dialog", { name: t("shell.mobile.more"), exact: true });
    await actUntilVisible(
      () => page.getByRole("button", { name: t("shell.mobile.more"), exact: true }).tap(),
      sheet,
    );
    await sheet.getByRole("button", { name: t("shell.rail.settings"), exact: true }).tap();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await noSidewaysScroll(page);
  });

  // From outside: the one command ran once, with the owner's answer.
  const { sessions } = await pap.rpc<{ sessions: { id: string }[] }>("sessions.list");
  expect(sessions).toHaveLength(1);
  const { entries } = await pap.rpc<{ entries: { kind: string; tool: string | null; decision: string }[] }>(
    "audit.list",
    { sessionId: sessions[0]?.id },
  );
  expect(
    entries.filter((row) => row.kind === "call" && row.tool === "bash").map((row) => row.decision),
  ).toEqual(["approved"]);
});
