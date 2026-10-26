// J10: Settings › Models. A provider is added from the Ollama preset (a loopback base URL, no key), the form refuses an
// address outside this machine with the catalog's sentence, and "My selection" offers exactly one model to a new session's
// picker. From outside: models.json holds the provider and no key, auth.json is byte for byte what it was, and each switch
// changes enabledModels in settings.json before the page shows it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Locator, Page } from "@playwright/test";
import { expect, scripted, stepUp, t, test } from "./fixtures.ts";
import type { PapInstance } from "./fixtures.ts";

const BASE_URL = "http://127.0.0.1:9/v1";
const KEPT = { id: "alpha-1", name: "Alpha One" };
const DROPPED = { id: "beta-2", name: "Beta Two" };
const FAKE_KEY = "e2e-fake-not-a-key";

// The new session of the last step needs a script to start its worker.
test.use({ papScript: scripted([{ text: "Ready." }]) });

const availability = (page: Page) => page.locator("[data-availability]");
const form = (page: Page) => page.locator("[data-provider-form]");

interface ModelsFile {
  providers: Record<string, { baseUrl: string; apiKey?: string; models: { id: string }[] }>;
}

/**
 * Pi's `enabledModels` in its settings file: null with no list, undefined while the file is missing or half written (Pi
 * writes it in place, ADR 0029).
 */
function enabledModels(pap: PapInstance): unknown {
  try {
    const settings = JSON.parse(readFileSync(join(pap.agentDir, "settings.json"), "utf8")) as {
      enabledModels?: unknown;
    };
    return settings.enabledModels ?? null;
  } catch {
    return undefined;
  }
}

/**
 * A switch shows what was asked from the click until the list read after its write is in: two Pi helper runs one after
 * the other, the write (`models.setEnabled`) and then that read (`models.overview`). So the click is followed by the
 * write in Pi's file first, then by the switch, each with its own wait.
 */
async function switchOff(pap: PapInstance, control: Locator): Promise<void> {
  const before = enabledModels(pap);
  await control.click();
  await expect
    .poll(
      () => {
        const now = enabledModels(pap);
        return Array.isArray(now) && !isDeepStrictEqual(now, before);
      },
      { message: "the write changes enabledModels in Pi's settings.json" },
    )
    .toBe(true);
  await expect(control).not.toBeChecked();
}

test("J10: a provider is added, one model is selected, a new session offers only that one", async ({
  page,
  pap,
  signedIn,
}) => {
  const authBefore = readFileSync(join(pap.agentDir, "auth.json"), "utf8");
  await signedIn.goto(`${pap.origin}/settings/models`);

  await test.step("the form refuses an address outside this machine with the catalog's sentence", async () => {
    await page.getByRole("button", { name: t("settingsProviders.add"), exact: true }).click();
    await page.getByRole("button", { name: t("settingsProviders.preset.ollama"), exact: true }).click();
    await expect(
      form(page).getByRole("radio", { name: t("settingsProviders.auth.none"), exact: true }),
    ).toBeChecked();
    const url = form(page).getByLabel(t("settingsProviders.field.url"), { exact: true });
    await url.fill("http://example.invalid");
    await expect(
      form(page).getByText(t("settingsProviders.problem.baseUrl.host"), { exact: true }),
    ).toBeVisible();
    await expect(
      form(page).getByRole("button", { name: t("settingsProviders.save"), exact: true }),
    ).toBeDisabled();
    await url.fill(BASE_URL);
    await expect(
      form(page).getByText(t("settingsProviders.problem.baseUrl.host"), { exact: true }),
    ).toBeHidden();
  });

  await test.step("two models by hand, then Save with the step-up", async () => {
    for (const [at, model] of [KEPT, DROPPED].entries()) {
      await form(page)
        .getByRole("button", { name: t("settingsProviders.models.add"), exact: true })
        .click();
      const row = form(page).locator(`[data-model-row="models.${at}"]`);
      await row.getByLabel(t("settingsProviders.models.id"), { exact: true }).fill(model.id);
      await row.getByLabel(t("settingsProviders.models.name"), { exact: true }).fill(model.name);
    }
    await stepUp(page, pap);
    await form(page)
      .getByRole("button", { name: t("settingsProviders.save"), exact: true })
      .click();
    await expect(form(page)).toBeHidden();
    const providers = page.getByRole("list", { name: t("settingsModels.list.label"), exact: true });
    await expect(providers.locator('[data-provider="ollama"]')).toBeVisible();
    await expect(providers.locator('[data-edit-provider="ollama"]')).toBeVisible();
  });

  // From outside: the provider is in the file, no key is, and Pi's sign-in file is untouched.
  const file = readFileSync(join(pap.agentDir, "models.json"), "utf8");
  const saved = (JSON.parse(file) as ModelsFile).providers["ollama"];
  expect(saved?.baseUrl).toBe(BASE_URL);
  expect(saved?.models.map((model) => model.id)).toEqual([KEPT.id, DROPPED.id]);
  expect(saved?.apiKey === undefined || saved.apiKey === "local-no-key").toBe(true); // the keyless placeholder, no secret
  expect(file).not.toContain(FAKE_KEY);
  expect(readFileSync(join(pap.agentDir, "auth.json"), "utf8")).toBe(authBefore);

  await test.step("My selection: the other connected provider and one model are switched off", async () => {
    const section = availability(page);
    await section.getByRole("radio", { name: t("settingsAvailability.mode.selection"), exact: true }).click();
    // A switch changes after the list is read again, so the click is followed by the state, not by Playwright's own check.
    await switchOff(pap, section.locator('[data-provider-row="anthropic"]').getByRole("switch").first());
    await section
      .getByRole("button", { name: t("settingsAvailability.expand", { provider: "Ollama" }), exact: true })
      .click();
    await switchOff(pap, section.getByRole("switch", { name: DROPPED.name, exact: true }));
    const preview = section.locator("[data-preview]");
    await expect(preview.locator("[data-preview-model]")).toHaveCount(1);
    await expect(
      preview.locator(`[data-preview-group="ollama"] [data-preview-model="${KEPT.id}"]`),
    ).toBeVisible();
  });
  const offered = await pap.rpc<{ models: { provider: string; id: string }[] }>("models.available", {});
  expect(offered.models.map((model) => `${model.provider}/${model.id}`)).toEqual([`ollama/${KEPT.id}`]);

  await test.step("a new session's picker lists exactly that model, and the search box filters", async () => {
    const { sessionId } = await pap.rpc<{ sessionId: string }>("sessions.create", { cwd: pap.work });
    await page.goto(`${pap.origin}/s/${sessionId}`);
    await page.locator("[data-model-bar]").getByRole("button").first().click();
    const menu = page.getByRole("dialog", { name: t("sessionModels.menu.title"), exact: true });
    const rows = menu.getByRole("option");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-model-row", KEPT.id);
    const search = menu.getByRole("combobox", { name: t("modelPicker.search"), exact: true });
    await search.fill("zzz");
    await expect(menu.getByText(t("modelPicker.noMatch"), { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    await search.fill("alpha");
    await expect(rows).toHaveCount(1);
  });
});
