// J11: the Files explorer opens README.md, the editor saves a line the disk then holds, and an address that climbs out of
// the project is refused with nothing read (the daemon's debug log names the denial). Then a terminal: the command's
// output shows, survives a reload, and the shell is gone once the terminal is closed.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";
import { actUntilVisible, liveProcesses } from "./seed.ts";

// The session of the terminal test needs a script to start its worker.
test.use({ papEnv: { PAP_LOG_LEVEL: "debug" }, papScript: scripted([{ text: "Ready." }]) });

const LINE = "e2e-j11 edited in the browser";
const root = (work: string): string => Buffer.from(work).toString("base64url");
const refusals = (lines: Record<string, unknown>[]) =>
  lines.filter((line) => line["msg"] === "files_refused");

// The page offers xterm's DOM renderer when the browser has no WebGL2: the output is then text a locator can read.
const withoutWebgl = (page: Page) =>
  page.context().addInitScript(() => {
    Reflect.deleteProperty(window, "WebGL2RenderingContext");
  });

test("J11: a file is edited and saved, a path outside the project is refused", async ({
  page,
  pap,
  signedIn,
}) => {
  await signedIn.goto(`${pap.origin}/explore/${root(pap.work)}`);
  const readme = page.locator(`[role="treeitem"][data-path="${join(pap.work, "README.md")}"]`);

  await test.step("open README.md and save a line typed in the editor", async () => {
    await readme.click();
    await page.getByRole("radio", { name: t("files.viewer.source"), exact: true }).click();
    const editor = page.getByRole("textbox", { name: t("files.viewer.editorLabel"), exact: true });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(LINE);
    await expect(page.getByText(t("files.edit.unsaved"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("files.edit.save"), exact: true }).click();
    await expect(page.getByText(t("files.edit.saved"), { exact: true })).toBeVisible();
  });
  const saved = readFileSync(join(pap.work, "README.md"), "utf8");
  expect(saved).toContain(LINE);
  expect(saved.startsWith("e2e\n")).toBe(true);

  await test.step("an address that climbs out of the project is refused and nothing is read", async () => {
    const before = refusals(pap.lines()).length;
    const outside = await page.context().newPage();
    const answer = await outside.goto(
      `${pap.origin}/files/raw?path=${encodeURIComponent(`${pap.work}/../../etc/passwd`)}`,
    );
    expect(answer?.status()).toBe(404);
    const body = await outside.locator("body").innerText();
    expect(JSON.parse(body)).toEqual({ error: { code: "not_found" } });
    expect(body).not.toContain("root:");
    await outside.close();
    await expect.poll(() => refusals(pap.lines()).length).toBeGreaterThan(before);
  });
});

test("J11: a terminal runs a command, keeps its output over a reload and ends with Close", async ({
  page,
  pap,
  signedIn,
}) => {
  await withoutWebgl(page);
  // A project is listed once it has a session; the home's Terminal button then opens a shell in its folder.
  const { sessionId } = await pap.rpc<{ sessionId: string }>("sessions.create", { cwd: pap.work });
  await expect
    .poll(async () => {
      const { sessions } = await pap.rpc<{ sessions: { id: string; status: string }[] }>("sessions.list");
      return sessions.find((session) => session.id === sessionId)?.status;
    })
    .toBe("idle");
  await signedIn.goto(pap.origin);
  const idle = liveProcesses(pap);

  await test.step("open a terminal from the project's home and run a command", async () => {
    const chip = page.getByRole("banner").getByRole("button", {
      name: t("shell.project.label", { name: t("shell.project.all") }),
      exact: true,
    });
    const choice = page.getByRole("menuitem", { name: basename(pap.work), exact: true });
    await actUntilVisible(() => chip.click(), choice);
    await choice.click();
    await page.getByRole("button", { name: t("home.action.terminal"), exact: true }).click();
    await expect(page).toHaveURL(/\/term\/[A-Za-z0-9_-]{22}$/);
    const terminal = page.getByRole("group", { name: t("terminal.surface.label"), exact: true });
    await terminal.click();
    await page.keyboard.type("echo e2e-term-ok");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows > div").filter({ hasText: /^e2e-term-ok\s*$/ })).toHaveCount(
      1,
    );
  });
  expect(liveProcesses(pap)).toBeGreaterThan(idle);

  await test.step("after a reload the scrollback still shows the output", async () => {
    await page.reload();
    const terminal = page.getByRole("group", { name: t("terminal.surface.label"), exact: true });
    await expect(terminal.locator(".xterm-rows > div").filter({ hasText: /^e2e-term-ok\s*$/ })).toHaveCount(
      1,
    );
  });

  await test.step("Close ends the shell", async () => {
    await page.getByRole("button", { name: t("terminal.action.close"), exact: true }).click();
    await page.getByRole("button", { name: t("terminal.action.closeConfirm"), exact: true }).click();
    await expect.poll(() => liveProcesses(pap)).toBe(idle);
  });
});
