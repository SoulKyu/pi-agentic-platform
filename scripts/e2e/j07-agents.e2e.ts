/// <reference lib="dom" />
// J07: the journey of a machine with no VM stack (an e2e daemon has no pap-vmd and no KVM). The owner opens the New agent
// flow and sees the microVM EmptyState ("Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`. See
// `pap doctor`.") in place of the form: nothing can be submitted, and no agent is made.
import type { Page } from "@playwright/test";
import { expect, t, test } from "./fixtures.ts";

const rail = (page: Page) => page.getByRole("navigation", { name: t("shell.rail.label"), exact: true });

test("J07: without a VM stack, the New agent dialog explains why and nothing is made", async ({
  page,
  pap,
  signedIn,
}) => {
  await signedIn.goto(pap.origin);
  const dialog = page.getByRole("dialog", { name: t("agentForm.dialog.title"), exact: true });
  await rail(page)
    .getByRole("button", { name: t("shell.rail.newAgent"), exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(t("agentsPhone.noVmPurpose").replaceAll("`", ""), { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel(t("agentForm.name"), { exact: true })).toHaveCount(0);
  const { agents } = await pap.rpc<{ agents: { name: string }[] }>("agents.list");
  expect(agents.filter((agent) => agent.name === "Scout")).toEqual([]);
});
