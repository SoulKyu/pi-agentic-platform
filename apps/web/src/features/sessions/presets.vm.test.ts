// @vitest-environment happy-dom
import { TOOL_PRESETS } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionToolsEn, sessionToolsFr } from "../../i18n/catalog/session-tools.ts";
import { crossesChat, LAST_PRESET_KEY, lastPreset, PRESET_ORDER, rememberPreset } from "./presets.vm.ts";

beforeEach(() => localStorage.clear());

describe("preset list", () => {
  it("offers every preset of the contract exactly once", () => {
    expect([...PRESET_ORDER].sort()).toEqual([...TOOL_PRESETS].sort());
  });

  it("has a name and a one-line meaning in en and fr for each", () => {
    for (const preset of TOOL_PRESETS) {
      for (const catalog of [sessionToolsEn, sessionToolsFr] as Record<string, string>[]) {
        expect(catalog[`sessionTools.name.${preset}`]).toBeTruthy();
        expect(catalog[`sessionTools.about.${preset}`]).toBeTruthy();
      }
    }
  });

  it("says in both languages that a read-only session asks for everything but reads, even in full access", () => {
    expect(sessionToolsEn["sessionTools.about.read-only"]).toBe(
      "Reads run. Anything else asks every time, even in full access.",
    );
    expect(sessionToolsFr["sessionTools.about.read-only"]).toBe(
      "Les lectures s'exécutent. Tout le reste demande à chaque fois, même en accès complet.",
    );
  });
});

describe("crossesChat", () => {
  it("is true into and out of chat, false between other presets and when the session is cold", () => {
    expect(crossesChat("full", "chat")).toBe(true);
    expect(crossesChat("chat", "none")).toBe(true);
    expect(crossesChat("full", "read-only")).toBe(false);
    expect(crossesChat("chat", "chat")).toBe(false);
    expect(crossesChat(null, "chat")).toBe(false);
  });
});

describe("last explicit choice", () => {
  it("is configured until a choice was made, then the choice", () => {
    expect(lastPreset()).toBe("configured");
    rememberPreset("read-only");
    expect(localStorage.getItem(LAST_PRESET_KEY)).toBe("read-only");
    expect(lastPreset()).toBe("read-only");
  });

  it("ignores a stored value it does not know", () => {
    localStorage.setItem(LAST_PRESET_KEY, "root");
    expect(lastPreset()).toBe("configured");
  });
});
