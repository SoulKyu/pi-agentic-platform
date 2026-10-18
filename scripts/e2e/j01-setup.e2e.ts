// J01: setup and passkey. The one journey that creates the owner through the page, so it never uses `signedIn` and runs on
// a worker whose daemon has no owner yet (the marker in papEnv gives it a worker of its own, M13R41).
import type { Page } from "@playwright/test";
import { expect, t, test } from "./fixtures.ts";

test.use({ papEnv: { PAP_E2E_JOURNEY: "j01-setup" } });

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactly = (...texts: string[]): RegExp => new RegExp(`^(${texts.map(escape).join("|")})$`);
const throttled = (): RegExp => {
  const [before = "", after = ""] = t("login.throttled", { seconds: "@@" }).split("@@");
  return new RegExp(`^${escape(before)}\\d+${escape(after)}$`);
};

// A marker that exists whatever tab the app restores after a sign-in: the project button of the banner.
const home = (page: Page) =>
  page.getByRole("banner").getByRole("button", {
    name: t("shell.project.label", { name: t("shell.project.all") }),
    exact: true,
  });
const signInHeading = (page: Page) => page.getByRole("heading", { name: t("login.title"), exact: true });
const alert = (page: Page, text: string | RegExp) => page.getByRole("alert").filter({ hasText: text });

async function signInWithPassword(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel(t("setup.username"), { exact: true }).fill(username);
  await page.getByLabel(t("setup.password"), { exact: true }).fill(password);
  await page.getByRole("button", { name: t("login.submit"), exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: t("shell.rail.settings"), exact: true }).click();
  await page.getByRole("link", { name: t("settings.section.account"), exact: true }).click();
  await page.getByRole("button", { name: t("settings.account.signOut"), exact: true }).click();
  await expect(signInHeading(page)).toBeVisible();
}

test("J01: the owner is created on the setup page, signs in again by password and by passkey", async ({
  page,
  pap,
  browserName,
}) => {
  const { username, password } = pap.owner;

  await test.step("setup through the page, then the first-run steps are skipped", async () => {
    await page.goto(pap.setupUrl);
    await expect(page.getByRole("heading", { name: t("setup.title"), exact: true })).toBeVisible();
    await page.getByLabel(t("setup.username"), { exact: true }).fill(username);
    await page.getByLabel(t("setup.password"), { exact: true }).fill(password);
    await page.getByRole("button", { name: t("setup.submit"), exact: true }).click();
    const leave = page.getByRole("button", {
      name: exactly(t("firstRun.skip"), t("firstRun.continue"), t("firstRun.finish")),
    });
    await expect(page.getByRole("heading", { name: t("firstRun.passkey.title"), exact: true })).toBeVisible();
    await leave.last().click();
    await expect(page.getByRole("heading", { name: t("firstRun.pi.title"), exact: true })).toBeVisible();
    await leave.last().click();
    await expect(home(page)).toBeVisible();
  });

  await test.step("passkey (Chromium only): add one in Settings, sign out, sign in with it", async () => {
    // Not `test.skip`: it would end the whole test, and the password half below runs on WebKit too (M13R5).
    if (browserName === "webkit") {
      test.info().annotations.push({ type: "skip", description: "no virtual authenticator in WebKit" });
      return;
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.getByRole("button", { name: t("shell.rail.settings"), exact: true }).click();
    await page.getByRole("link", { name: t("settings.section.account"), exact: true }).click();
    await page.getByRole("button", { name: t("account.addPasskey"), exact: true }).click();
    await page.getByLabel(t("setup.password"), { exact: true }).fill(password);
    await page.getByRole("button", { name: t("account.addPasskey"), exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: t("account.passkeyAdded") })).toBeVisible();
    await expect
      .poll(async () => (await pap.rpc<{ passkeys: unknown[] }>("auth.passkeys.list")).passkeys.length)
      .toBe(1);
    await page.getByRole("button", { name: t("settings.account.signOut"), exact: true }).click();
    await expect(signInHeading(page)).toBeVisible();
    await page.getByRole("button", { name: t("login.passkey"), exact: true }).click();
    await expect(home(page)).toBeVisible();
    const methods = (
      await pap.rpc<{ devices: { method: string | null }[] }>("auth.devices.list")
    ).devices.map((d) => d.method);
    expect(methods).toContain("passkey");
  });

  await test.step("password sign-in, read from outside", async () => {
    await signOut(page);
    await signInWithPassword(page, username, password);
    await expect(home(page)).toBeVisible();
    const { devices } = await pap.rpc<{ devices: { method: string | null; current: boolean }[] }>(
      "auth.devices.list",
    );
    expect(devices.map((device) => device.method)).toContain("password");
  });

  await test.step("the setup address no longer works", async () => {
    await signOut(page);
    await page.goto(pap.setupUrl);
    await expect(signInHeading(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: t("setup.title"), exact: true })).toHaveCount(0);
    const refused = await page.request.post(`${pap.origin}/auth/setup`, {
      data: {
        token: new URL(pap.setupUrl).hash.replace("#token=", ""),
        username: "second",
        password: `${password}-2`,
      },
      headers: { origin: pap.origin },
    });
    expect(refused.status()).toBeGreaterThanOrEqual(400);
  });

  await test.step("a wrong password shows the catalog error, repeated ones show the throttle line", async () => {
    await signInWithPassword(page, username, `${password}-wrong`);
    await expect(alert(page, t("login.failed"))).toBeVisible();
    await expect(async () => {
      await signInWithPassword(page, username, `${password}-wrong`);
      await expect(alert(page, throttled())).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });

  const lines = pap.lines();
  expect(lines.filter((line) => line["msg"] === "setup_url")).toHaveLength(1);
  expect(lines.filter((line) => line["level"] === "error")).toEqual([]);
});
