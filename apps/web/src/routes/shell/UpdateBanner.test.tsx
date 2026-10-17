// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { registerServiceWorker } from "../../features/pwa/index.ts";
import { usePwa } from "../../stores/pwa.ts";
import { mount } from "../../testing/dom.ts";
import { fakePwaEnv, settled } from "../../testing/pwa-env.ts";
import UpdateBanner from "./UpdateBanner.tsx";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
  setLocale("fr");
});

describe("UpdateBanner", () => {
  it("says in French that the page has an update, about the page and not a pap release", async () => {
    usePwa.getState().markUpdateReady();
    const page = await mount(<UpdateBanner />);
    expect(page.container.textContent).toContain("La page a une mise à jour");
    expect([...page.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Plus tard",
      "Recharger",
    ]);
    expect(page.container.textContent).not.toMatch(/version de pap|release/i);
    await page.unmount();
  });

  it("its button posts skip-waiting and the page reloads once on controllerchange", async () => {
    const env = fakePwaEnv();
    env.container.controller = {};
    registerServiceWorker(env.env);
    await settled();
    const worker = env.container.registration.found();
    env.container.registration.waiting = worker;
    worker.become("installed");
    const page = await mount(<UpdateBanner />);
    const button = [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Recharger");
    button?.click();
    button?.click();
    expect(worker.posted).toEqual([{ type: "skip-waiting" }, { type: "skip-waiting" }]);
    env.container.dispatchEvent(new Event("controllerchange"));
    env.container.dispatchEvent(new Event("controllerchange"));
    expect(env.reloads).toHaveLength(1);
    await page.unmount();
  });

  it("Plus tard hides the update for this page load only; the failed state then shows if it is true", async () => {
    usePwa.getState().markUpdateReady();
    const page = await mount(<UpdateBanner />);
    [...page.container.querySelectorAll("button")].find((b) => b.textContent === "Plus tard")?.click();
    await settled();
    expect(page.container.innerHTML).toBe("");
    expect(usePwa.getState().updateReady).toBe(true);
    await page.unmount();
  });

  it("Masquer hides the failed registration, with Hide in English", async () => {
    usePwa.getState().setRegistrationFailed(true);
    const page = await mount(<UpdateBanner />);
    const hide = page.container.querySelector("button");
    expect(hide?.textContent).toBe("Masquer");
    hide?.click();
    await settled();
    expect(page.container.innerHTML).toBe("");
    await page.unmount();
    setLocale("en");
    usePwa.setState(usePwa.getInitialState(), true);
    usePwa.getState().setRegistrationFailed(true);
    const english = await mount(<UpdateBanner />);
    expect(english.container.querySelector("button")?.textContent).toBe("Hide");
    await english.unmount();
  });

  it("shows the failed registration, not a wait for ready", async () => {
    usePwa.getState().setRegistrationFailed(true);
    const page = await mount(<UpdateBanner />);
    expect(page.container.textContent).toContain("sw.js");
    expect(page.container.textContent).not.toContain("La page a une mise à jour");
    await page.unmount();
  });

  it("renders in English too", async () => {
    setLocale("en");
    usePwa.getState().markUpdateReady();
    const page = await mount(<UpdateBanner />);
    expect(page.container.textContent).toContain("The page has an update");
    await page.unmount();
  });

  it("renders nothing when there is nothing to say", async () => {
    const page = await mount(<UpdateBanner />);
    expect(page.container.innerHTML).toBe("");
    await page.unmount();
  });
});
