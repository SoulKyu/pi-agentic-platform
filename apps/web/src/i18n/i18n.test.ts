import { ERROR_CODES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { CLIENT_ERROR_CODES, errorKey, pickLocale, plural, translate } from "./index.ts";

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
      if (key !== "app.name") expect(fr[key], key).not.toBe(en[key]);
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

  it("picks the plural form of the locale, with the count, and falls back to the other form", () => {
    expect(plural("en", "sessions.queue.more", 1)).toBe("1 more");
    expect(plural("en", "sessions.queue.more", 7)).toBe("7 more");
    expect(plural("fr", "sessions.queue.more", 0)).toBe("0 de plus");
    expect(plural("fr", "sessions.queue.more", 1_000_000)).toBe("1000000 de plus");
  });
});
