// J17: shell blocks of a reply go to the session's terminal (UX-1). Nothing runs before the owner presses Enter, and a shell
// that cannot hold several lines gets nothing typed. The ends are files in the project folder, read from outside the page.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";

const FENCE = "```";
const REPLY = [
  "Three blocks to try:",
  "",
  `${FENCE}bash\ntouch ux1-one\n${FENCE}`,
  "",
  `${FENCE}bash\ntouch ux1-a\ntouch ux1-b\n${FENCE}`,
  "",
  `${FENCE}bash\ntouch ux1-x\ntouch ux1-y\n${FENCE}`,
].join("\n");

test.use({ papEnv: { SHELL: "/bin/bash" }, papScript: scripted([{ text: REPLY }]) });

const withoutWebgl = (page: Page) =>
  page.context().addInitScript(() => {
    Reflect.deleteProperty(window, "WebGL2RenderingContext");
  });

const made = (work: string, name: string): boolean => existsSync(join(work, name));
const rowsWith = (page: Page, text: string) =>
  page
    .getByRole("group", { name: t("terminal.surface.label"), exact: true })
    .locator(".xterm-rows > div")
    .filter({ hasText: text });
const toTerminal = (page: Page, block: number) =>
  page
    .locator("[data-shell-block]")
    .nth(block)
    .getByRole("button", { name: t("reply.shell.toTerminal"), exact: true });

test("J17: To terminal types a block and waits for Enter; a shell without bracketed paste gets nothing", async ({
  page,
  pap,
  signedIn,
}) => {
  await withoutWebgl(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn.goto(pap.origin);
  await page.getByLabel(t("launch.field"), { exact: true }).fill("Show me three blocks");
  await page.getByRole("button", { name: t("launch.go.session"), exact: true }).click();
  await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
  await expect(page.locator("[data-shell-block]")).toHaveCount(3);

  await test.step("a single line is typed, not run; Enter runs it", async () => {
    await toTerminal(page, 0).click();
    await expect(rowsWith(page, "touch ux1-one")).toHaveCount(1);
    await expect(page.getByText(t("reply.shell.typed"), { exact: true })).toBeVisible();
    expect(made(pap.work, "ux1-one")).toBe(false);
    await page.keyboard.press("Enter");
    await expect.poll(() => made(pap.work, "ux1-one")).toBe(true);
  });

  await test.step("two lines with bracketed paste on are typed together, not run; Enter runs both", async () => {
    await toTerminal(page, 1).click();
    await expect(rowsWith(page, "touch ux1-a")).toHaveCount(1);
    await expect(rowsWith(page, "touch ux1-b")).toHaveCount(1);
    expect(made(pap.work, "ux1-a")).toBe(false);
    expect(made(pap.work, "ux1-b")).toBe(false);
    await page.keyboard.press("Enter");
    await expect.poll(() => made(pap.work, "ux1-a") && made(pap.work, "ux1-b")).toBe(true);
  });

  await test.step("with bracketed paste off two lines are refused and nothing is typed", async () => {
    await page.keyboard.type("bind 'set enable-bracketed-paste off'");
    await page.keyboard.press("Enter");
    await expect(rowsWith(page, "enable-bracketed-paste off")).not.toHaveCount(0);
    await toTerminal(page, 2).click();
    await expect(page.getByRole("alert").filter({ hasText: t("reply.shell.multiline") })).toBeVisible();
    await expect(rowsWith(page, "touch ux1-x")).toHaveCount(0);
  });
  expect(made(pap.work, "ux1-x")).toBe(false);
  expect(made(pap.work, "ux1-y")).toBe(false);
});
