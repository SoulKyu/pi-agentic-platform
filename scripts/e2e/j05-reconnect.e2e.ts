// J05: the daemon restarts while an approval card is open; the page reconnects by itself, the old card is closed, and a
// second prompt on the same session raises the approval again and finishes. Each worker walks the script from step 0,
// the one the restart creates included: step 0 asks, step 1 answers.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";

const MARKER = "e2e-j05-ok";

test.use({
  papScript: scripted([
    { toolCalls: [{ name: "bash", id: "j05-bash", args: { command: `env echo ${MARKER}` } }] },
    { text: `The command printed ${MARKER}.` },
  ]),
});

const approval = (page: Page) =>
  page.getByRole("alertdialog", {
    name: `${t("dialog.approval")} ${t("dialog.category.exec")}`,
    exact: true,
  });

test("J05: a daemon restart closes the open approval and the session resumes", async ({
  page,
  pap,
  signedIn,
}) => {
  await signedIn.goto(pap.origin);
  await page.getByLabel(t("launch.field"), { exact: true }).fill("First prompt");
  await page.getByRole("button", { name: t("launch.go.session"), exact: true }).click();
  await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
  await expect(approval(page)).toBeVisible();

  const { sessions } = await pap.rpc<{ sessions: { id: string }[] }>("sessions.list");
  expect(sessions).toHaveLength(1);
  const [{ id: sessionId } = { id: "" }] = sessions;
  expect(sessionId).not.toBe("");
  const entries = (): PiEntry[] =>
    readFileSync(pap.piFile(sessionId), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as PiEntry);
  const before = entries().length;

  await test.step("restart the daemon under the open card", async () => {
    const lost = page
      .getByText(new RegExp(`^(${t("connection.silent")}|${t("connection.reconnecting")})$`))
      .first();
    const seen = lost.waitFor({ state: "visible" });
    await pap.restart();
    await seen;
    await expect(lost).toBeHidden({ timeout: 30_000 });
    await expect(approval(page)).toBeHidden();
  });
  const afterRestart = entries().length;

  await test.step("the old card is gone and its cause is shown on the session", async () => {
    await expect(page.getByRole("alert").filter({ hasText: t("session.failure") })).toBeVisible();
  });

  await test.step("a second prompt on the same session asks again, allow it once", async () => {
    await page.getByLabel(t("session.composer"), { exact: true }).fill("Second prompt");
    await page.getByRole("button", { name: t("sessions.composer.send"), exact: true }).click();
    await expect(approval(page)).toBeVisible();
    await approval(page)
      .getByRole("button", { name: t("dialog.answer.once"), exact: true })
      .click();
    await expect(page.getByText(`The command printed ${MARKER}.`, { exact: true })).toBeVisible();
  });

  // The restart's shutdown aborted the open call (a tool result and an empty assistant entry), then the new exchange:
  // user, tool call, tool result, answer. Nothing twice.
  const roles = (list: PiEntry[]) =>
    list.filter((entry) => entry.type === "message").map((entry) => entry.message?.role);
  expect(roles(entries().slice(before, afterRestart))).toEqual(["toolResult", "assistant"]);
  expect(roles(entries().slice(afterRestart))).toEqual(["user", "assistant", "toolResult", "assistant"]);
  const file = entries().filter((entry) => entry.type === "message" && entry.message);
  const texts = (role: string) =>
    file.filter(
      (entry) =>
        entry.message?.role === role && JSON.stringify(entry.message.content).includes('"type":"text"'),
    );
  await expect(page.getByRole("article", { name: "You", exact: true })).toHaveCount(texts("user").length);
  await expect(page.getByRole("article", { name: "Agent", exact: true })).toHaveCount(
    texts("assistant").length,
  );
});

interface PiEntry {
  type: string;
  message?: { role: string; content: unknown };
}
