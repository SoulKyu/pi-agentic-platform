import { describe, expect, it } from "vitest";
import { catalogs, plural, t } from "./catalog.ts";

describe("the e2e English catalog (M13R37)", () => {
  it("resolves an eager key", () => {
    expect(t("setup.title")).toBe("Create the owner account");
    expect(t("login.failed")).toBe("Wrong username or password.");
  });

  it("resolves a key that lives only in a lazy catalog", () => {
    expect(t("inbox.agent.line.approve", { name: "Atlas" })).toBe("Atlas asks for your approval");
  });

  it("interpolates {name} and leaves an unknown placeholder untouched", () => {
    expect(t("login.throttled", { seconds: 4 })).toBe("Too many attempts. Wait 4 s.");
    expect(t("login.throttled")).toBe("Too many attempts. Wait {seconds} s.");
    expect(t("login.throttled", { other: 1 })).toBe("Too many attempts. Wait {seconds} s.");
  });

  it("picks .one and .other by the English plural rules", () => {
    expect(plural("home.status.lanes", 1)).toBe("1 active lane");
    expect(plural("home.status.lanes", 3)).toBe("3 active lanes");
    expect(plural("home.status.lanes", 0)).toBe("0 active lanes");
  });

  it("falls back to .other when a form is missing", () => {
    expect(plural("access.devices.signedOut", 1)).toBe("1 device signed out");
    expect(plural("compare.error", 1)).toBe("The request failed. Try again.");
  });

  it("throws on a missing key", () => {
    expect(() => t("no.such.key")).toThrow(/no\.such\.key/);
    expect(() => plural("no.such", 2)).toThrow(/no\.such/);
  });

  it("leaves out the dev-only keys (import.meta.env.DEV is false)", () => {
    expect(catalogs().en["shell.tab.devUi"]).toBeUndefined();
    expect(() => t("shell.tab.devUi")).toThrow();
  });

  it("carries the French catalog too, merged the same way", () => {
    expect(catalogs().fr["setup.title"]).toBe("Créer le compte propriétaire");
    expect(catalogs().fr["inbox.agent.line.approve"]).toBe("{name} demande votre accord");
  });
});
