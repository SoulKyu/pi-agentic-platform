// @vitest-environment happy-dom
import { ERROR_CODES } from "@pap/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, text } from "../testing/dom.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import {
  CLIENT_ERROR_CODES,
  errorKey,
  getLocale,
  onLocaleChange,
  pickLocale,
  setLocale,
  switchLocale,
  translate,
  useT,
} from "./index.ts";

// Keys whose French is the same word (endonyms, product and font names). Every other key must differ.
const IDENTICAL_IN_FR = new Set([
  "app.name",
  "shell.tab.session",
  "shell.rail.label",
  "shell.top.tree",
  "settings.language.en",
  "settings.language.fr",
  "settings.appearance.fontManrope",
  "settings.appearance.fontJetbrains",
  "shell.pane.terminal",
  "commands.palette.title",
  "commands.group.navigation",
  "commands.group.session",
  "commands.group.agents",
  "commands.key.ctrl",
  "commands.key.alt",
  "commands.key.tab",
]);

describe("i18n", () => {
  it("every error code has an en and fr message", () => {
    for (const code of [...ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      const key = errorKey(code);
      expect(key, code).toBe(`error.${code}`);
      expect(en[key].length).toBeGreaterThan(0);
      expect(fr[key].length).toBeGreaterThan(0);
    }
    expect(errorKey("teapot")).toBe("error.internal");
  });

  it("translates every key into French", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(fr[key], key).toBeTruthy();
      if (!IDENTICAL_IN_FR.has(key)) expect(fr[key], key).not.toBe(en[key]);
    }
  });

  it("picks French for French browsers, English otherwise, and a stored choice wins", () => {
    expect(pickLocale(["fr-FR", "en"], null)).toBe("fr");
    expect(pickLocale(["de-DE"], null)).toBe("en");
    expect(pickLocale(["fr-FR"], "en")).toBe("en");
  });

  it("interpolates variables", () => {
    expect(translate("en", "login.throttled", { seconds: 4 })).toBe("Too many attempts. Wait 4 s.");
    expect(translate("fr", "login.throttled", { seconds: 4 })).toBe("Trop de tentatives. Attendez 4 s.");
  });
});

describe("reactive locale (R128)", () => {
  afterEach(() => {
    setLocale("en");
    vi.restoreAllMocks();
  });

  it("re-renders a component that reads useT when the locale changes", async () => {
    setLocale("en");
    function Probe() {
      const t = useT();
      return <p>{t("gate.retry")}</p>;
    }
    const page = await mount(<Probe />);
    expect(text(page.container)).toBe("Retry");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toBe("Réessayer");
    await act(async () => setLocale("en"));
    await page.unmount();
  });

  it("tells listeners once per real change", () => {
    setLocale("en");
    let calls = 0;
    const stop = onLocaleChange(() => calls++);
    setLocale("en");
    setLocale("fr");
    stop();
    setLocale("en");
    expect(calls).toBe(1);
  });

  it("switchLocale stores the choice and sets the document language", () => {
    const stored: Record<string, string> = {};
    expect(
      switchLocale("fr", {
        storage: { setItem: (k, v) => void (stored[k] = v) },
        root: document.documentElement,
      }),
    ).toBe(true);
    expect([getLocale(), stored["pap.locale"], document.documentElement.lang]).toEqual(["fr", "fr", "fr"]);
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });

  it("switches for this page and says so when the browser refuses to store the choice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = {
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(switchLocale("fr", { storage: refused, root: document.documentElement })).toBe(false);
    expect(getLocale()).toBe("fr");
    expect(warn.mock.calls).toEqual([["pap: storage_refused"]]);
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });
});
