// J04: a webhook trigger is created in the editor, an Alertmanager-shaped delivery runs a task, the Inbox lists it.
import { basename } from "node:path";
import { expect, scripted, stepUp, t, test } from "./fixtures.ts";

test.use({
  papScript: scripted([{ text: "Alert handled: disk almost full." }]),
});

const TRIGGER = "Handle the alert";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALERT = {
  version: "4",
  status: "firing",
  receiver: "pap",
  alerts: [
    {
      status: "firing",
      fingerprint: "e2efingerprint01",
      labels: { alertname: "E2EDiskFull", severity: "page" },
      annotations: { summary: "disk almost full" },
    },
  ],
};

test("J04: webhook to Inbox", async ({ page, pap, signedIn }) => {
  await signedIn.goto(pap.origin);
  await page.getByRole("radio", { name: t("launch.mode.trigger"), exact: true }).click();
  await page.getByLabel(t("launch.field"), { exact: true }).fill(TRIGGER);
  await page.getByRole("button", { name: t("launch.go.trigger"), exact: true }).click();
  await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
  await page.getByRole("radio", { name: t("automation.trigger.source.webhook"), exact: true }).click();
  await page
    .getByRole("radio", { name: t("automation.editor.webhook.formatAlertmanager"), exact: true })
    .click();
  await page.getByRole("switch", { name: t("automation.editor.enabled"), exact: true }).click();
  await stepUp(page, pap);
  await page.getByRole("button", { name: t("automation.editor.save"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("automation.editor.secret.title"), exact: true });
  const secret = await dialog
    .getByRole("textbox", { name: t("automation.editor.secret.value"), exact: true })
    .inputValue();
  expect(secret).toMatch(/^pwh_/);
  await dialog.getByRole("button", { name: t("automation.editor.secret.done"), exact: true }).click();
  await expect(
    page.getByRole("radio", { name: t("automation.editor.webhook.authSecret"), exact: true }),
  ).toBeChecked();
  const url = (await page.getByRole("code").filter({ hasText: "/hooks/" }).innerText()).trim();
  expect(url.startsWith(`${pap.origin}/hooks/`)).toBe(true);
  const triggerId = url.slice(url.lastIndexOf("/") + 1);

  // No Origin header: a webhook sender is not a browser. The secret header is X-Pap-Secret (docs/adr/0042-webhook-authentication.md, "Two modes").
  const post = (headers: Record<string, string>) =>
    fetch(url.replace("//localhost:", "//127.0.0.1:"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(ALERT),
    });
  const wrong = await post({ "X-Pap-Secret": `${secret}x` });
  expect(wrong.status).toBe(401);
  const accepted = await post({ "X-Pap-Secret": secret });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ taskId: expect.any(String) });
  const replay = await post({ "X-Pap-Secret": secret });
  expect(replay.status).toBe(409);

  await page.getByRole("button", { name: t("shell.top.inbox"), exact: true }).click();
  const row = page.getByRole("button", {
    name: new RegExp(`^${escape(t("inbox.title.done", { name: TRIGGER }))}`),
  });
  await expect(row).toBeVisible();
  await row.click();
  // The task's session opens: the payload sits in a labelled fence and the session starts tainted.
  await expect(
    page.getByRole("figure", { name: t("sessionPolicy.fence", { source: "alertmanager" }), exact: true }),
  ).toBeVisible();
  await expect(page.getByText(t("sessionPolicy.external"), { exact: true })).toBeVisible();
  await expect(page.getByText("Alert handled: disk almost full.", { exact: true })).toBeVisible();

  // From outside: the journal holds the three deliveries and the fired task is done; the Inbox holds one finished item;
  // the secret reached no log line.
  const { entries } = await pap.rpc<{ entries: Fire[] }>("automation.journal", { triggerId });
  expect(entries.map((entry) => entry.verdict).sort()).toEqual(["dedup", "fired", "unauthorized"]);
  const fired = entries.find((entry) => entry.verdict === "fired");
  expect(fired?.taskState).toBe("done");
  const { items } = await pap.rpc<{ items: { kind: string; taskId: string | null }[] }>("inbox.list", {});
  expect(items.map((item) => [item.kind, item.taskId])).toEqual([["task_done", fired?.taskId]]);
  expect(pap.lines().filter((line) => JSON.stringify(line).includes(secret))).toEqual([]);
});

interface Fire {
  verdict: string;
  taskId: string | null;
  taskState: string | null;
}
