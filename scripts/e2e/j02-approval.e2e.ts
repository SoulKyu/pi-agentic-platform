// J02: prompt, approval card, result. The first bash call is allowed once, the second is denied; the Pi file and the audit
// trail, read from outside the page, hold both decisions.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";

const ALLOWED = "e2e-j02-ok";
const DENIED = "e2e-j02-no";
const bash = (id: string, marker: string) => ({
  name: "bash",
  id,
  args: { command: `env echo ${marker}` },
});

test.use({
  papScript: scripted([
    { toolCalls: [bash("j02-allow", ALLOWED)] },
    { text: `The command printed ${ALLOWED}.` },
    { toolCalls: [bash("j02-deny", DENIED)] },
    { text: "The command was not run." },
  ]),
});

const home = (page: Page) =>
  page.getByRole("banner").getByRole("button", {
    name: t("shell.project.label", { name: t("shell.project.all") }),
    exact: true,
  });
const approval = (page: Page) =>
  page.getByRole("alertdialog", {
    name: `${t("dialog.approval")} ${t("dialog.category.exec")}`,
    exact: true,
  });
const composer = (page: Page) => page.getByLabel(t("session.composer"), { exact: true });

test("J02: a command waits for the owner's answer, once allowed and once denied", async ({
  page,
  pap,
  signedIn,
}) => {
  await signedIn.goto(pap.origin);
  await expect(home(page)).toBeVisible();

  await test.step("launch a session with the first prompt, allow the command once", async () => {
    await page.getByLabel(t("launch.field"), { exact: true }).fill("Run the first command");
    await page.getByRole("button", { name: t("launch.go.session"), exact: true }).click();
    await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
    const card = approval(page);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: t("dialog.answer.once"), exact: true }).click();
    await expect(page.getByText(`The command printed ${ALLOWED}.`, { exact: true })).toBeVisible();
  });

  await test.step("a second prompt on the same session, deny the command", async () => {
    await composer(page).fill("Run the second command");
    await page.getByRole("button", { name: t("sessions.composer.send"), exact: true }).click();
    const card = approval(page);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: t("dialog.answer.deny"), exact: true }).click();
    await expect(page.getByText("The command was not run.", { exact: true })).toBeVisible();
  });

  const { sessions } = await pap.rpc<{ sessions: { id: string }[] }>("sessions.list");
  expect(sessions).toHaveLength(1);
  const [{ id: sessionId } = { id: "" }] = sessions;
  expect(sessionId).not.toBe("");
  const results = readFileSync(pap.piFile(sessionId), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string; message?: ToolResult })
    .flatMap((entry) =>
      entry.type === "message" && entry.message?.role === "toolResult" ? [entry.message] : [],
    );
  expect(results.filter((result) => JSON.stringify(result.content).includes(ALLOWED))).toHaveLength(1);
  expect(results.find((result) => result.toolCallId === "j02-allow")?.isError).toBe(false);
  expect(results.find((result) => result.toolCallId === "j02-deny")?.isError).toBe(true);
  expect(JSON.stringify(results)).not.toContain(DENIED);

  const { entries } = await pap.rpc<{ entries: AuditRow[] }>("audit.list", { sessionId });
  const decisions = entries.filter((row) => row.kind === "call" && row.tool === "bash");
  expect(decisions.map((row) => [row.toolCallId, row.decision]).sort()).toEqual([
    ["j02-allow", "approved"],
    ["j02-deny", "denied"],
  ]);
});

interface ToolResult {
  role: string;
  toolCallId?: string;
  isError?: boolean;
  content: unknown;
}
interface AuditRow {
  kind: string;
  tool: string | null;
  decision: string;
  toolCallId: string | null;
  reason: string | null;
}
