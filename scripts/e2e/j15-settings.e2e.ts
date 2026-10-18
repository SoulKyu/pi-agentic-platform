// J15: Settings and devices. The language switches to French (the shell text changes and a reload keeps it), the theme goes
// to Day · Papier and back (the page's theme attribute and the account's stored setting follow), the owner signs out, signs
// in again, a second browser context signs in too, the device list shows both, and "Sign out other devices" in the second
// context ends the first one's session (it returns to the sign-in page). Outside: the stored appearance setting, the
// device list through the RPC with the second context's own cookie, and the first context's old cookie refused.
import type { Page } from "@playwright/test";
import { SESSION_COOKIE } from "./auth.ts";
import { catalogs } from "./catalog.ts";
import { expect, t, test } from "./fixtures.ts";
import type { PapInstance } from "./fixtures.ts";
import { rpcCall } from "./rpc.ts";

const french = (key: string): string => {
  const text = catalogs().fr[key];
  if (text === undefined) throw new Error(`the French catalog has no key "${key}"`);
  return text;
};

const signInHeading = (page: Page) => page.getByRole("heading", { name: t("login.title"), exact: true });
const home = (page: Page) =>
  page.getByRole("banner").getByRole("button", {
    name: t("shell.project.label", { name: t("shell.project.all") }),
    exact: true,
  });

async function signInWithPassword(page: Page, pap: PapInstance): Promise<void> {
  await page.getByLabel(t("setup.username"), { exact: true }).fill(pap.owner.username);
  await page.getByLabel(t("setup.password"), { exact: true }).fill(pap.owner.password);
  await page.getByRole("button", { name: t("login.submit"), exact: true }).click();
  await expect(home(page)).toBeVisible();
}

interface Appearance {
  mode?: string;
  darkTheme?: string;
  lightTheme?: string;
}
const storedAppearance = async (pap: PapInstance): Promise<Appearance> =>
  (await pap.rpc<{ value: Appearance | null }>("settings.get", { key: "appearance" })).value ?? {};

test("J15: the language switches to French and stays, the theme goes to Day · Papier and back", async ({
  page,
  pap,
  signedIn,
}) => {
  await test.step("French: the shell text changes, a reload keeps it", async () => {
    await signedIn.goto(`${pap.origin}/settings/language`);
    await page.getByRole("radio", { name: t("settings.language.fr"), exact: true }).click();
    const rail = (key: string) => page.getByRole("button", { name: french(key), exact: true });
    await expect(rail("shell.rail.settings")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(
      page.getByRole("heading", { name: french("settings.section.language"), exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(rail("shell.rail.settings")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    // The choice is the browser's own (per device): the key the page keeps, read from the page.
    expect(await page.evaluate(() => localStorage.getItem("pap.locale"))).toBe("fr");

    await page.getByRole("radio", { name: french("settings.language.en"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("shell.rail.settings"), exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await page.evaluate(() => localStorage.getItem("pap.locale"))).toBe("en");
  });

  await test.step("Day · Papier and back", async () => {
    await page.goto(`${pap.origin}/settings/appearance`);
    await page.getByRole("radio", { name: t("settings.appearance.mode.day"), exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "day");
    await expect(page.locator('[data-theme-card="day"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-theme-card="day"]')).toContainText(t("settings.appearance.preset.day"));
    await expect.poll(async () => (await storedAppearance(pap)).mode).toBe("day");

    await page.getByRole("radio", { name: t("settings.appearance.mode.night"), exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
    await expect.poll(async () => (await storedAppearance(pap)).mode).toBe("night");
  });
});

// Last in the file: it signs the shared session out, and `signedIn` of a later test would hand out its dead cookie.
test("J15: sign out, sign in on a second browser context, sign out the others", async ({
  browser,
  page,
  pap,
  signedIn,
}) => {
  const cookieOf = async (ownPage: Page): Promise<string> => {
    const found = (await ownPage.context().cookies(pap.origin)).find(
      (cookie) => cookie.name === SESSION_COOKIE,
    );
    if (!found) throw new Error("the page holds no session cookie");
    return found.value;
  };
  const second = await browser.newContext();
  try {
    await test.step("sign out lands on the sign-in page, and the old session is dead", async () => {
      await signedIn.goto(`${pap.origin}/settings/account`);
      const oldCookie = await cookieOf(page);
      await page.getByRole("button", { name: t("settings.account.signOut"), exact: true }).click();
      await expect(signInHeading(page)).toBeVisible();
      await expect(rpcCall(pap.origin, oldCookie, "auth.devices.list")).rejects.toThrow(/401/);
    });

    await test.step("the first context signs in again, the second context signs in", async () => {
      await signInWithPassword(page, pap);
      const other = await second.newPage();
      await other.goto(pap.origin);
      await expect(signInHeading(other)).toBeVisible();
      await signInWithPassword(other, pap);
    });

    const other = second.pages()[0];
    if (!other) throw new Error("the second context has no page");
    const firstCookie = await cookieOf(page);
    const secondCookie = await cookieOf(other);
    expect(secondCookie).not.toBe(firstCookie);

    await test.step("the device list shows two sessions, one of them this browser", async () => {
      await other.goto(`${pap.origin}/settings/account`);
      await expect(other.locator("[data-device]")).toHaveCount(2);
      await expect(other.getByText(t("access.devices.current"), { exact: true })).toHaveCount(1);
    });
    const { devices } = await rpcCall<{ devices: { current: boolean }[] }>(
      pap.origin,
      secondCookie,
      "auth.devices.list",
    );
    expect(devices.map((device) => device.current).sort()).toEqual([false, true]);

    await test.step("sign out the others: the second context stays, the first returns to sign-in", async () => {
      await other.getByRole("button", { name: t("access.devices.revokeOthers"), exact: true }).click();
      await other.getByRole("button", { name: t("access.devices.confirmOthers"), exact: true }).click();
      await expect(other.getByText(t("access.devices.signedOut.one"), { exact: true })).toBeVisible();
      await expect(other.locator("[data-device]")).toHaveCount(1);
      await expect(signInHeading(page)).toBeVisible();
    });

    // From outside: the first context's session is gone, the second's is the only one left.
    await expect(rpcCall(pap.origin, firstCookie, "auth.devices.list")).rejects.toThrow(/401/);
    const left = await rpcCall<{ devices: { current: boolean }[] }>(
      pap.origin,
      secondCookie,
      "auth.devices.list",
    );
    expect(left.devices).toHaveLength(1);
    expect(left.devices[0]?.current).toBe(true);
  } finally {
    await second.close();
  }
});
