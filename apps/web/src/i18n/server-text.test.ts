import { SERVER_CODES } from "@pap/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { serverEn, serverFr } from "./catalog/server.ts";
import { registerCatalog } from "./index.ts";
import { codedServerText, serverText } from "./server-text.ts";

beforeAll(() => registerCatalog({ en: serverEn, fr: serverFr }));

describe("server texts by pattern (the fallback for an event with no code)", () => {
  it.each([
    ["A message was too large to stream.", "Un message était trop volumineux pour être diffusé."],
    ["An extension failed.", "Une extension a échoué."],
    ["An extension failed during tool_call.", "Une extension a échoué pendant tool_call."],
    ["Agent process exited with code 70.", "Le processus de l'agent s'est arrêté avec le code 70."],
    ["Agent process stopped by SIGTERM.", "Le processus de l'agent a été arrêté par SIGTERM."],
    [
      "Agent process killed (SIGKILL), possibly out of memory.",
      "Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire.",
    ],
    [
      "Agent process ran out of memory and was stopped.",
      "Le processus de l'agent a manqué de mémoire et a été arrêté.",
    ],
    [
      "5 more notices from extensions were not shown.",
      "5 autres notifications d'extensions n'ont pas été affichées.",
    ],
  ])("translates %s", (english, french) => {
    expect(serverText(english, "en")).toBe(english);
    expect(serverText(english, "fr")).toBe(french);
  });

  it("shows an unknown sentence as sent, clipped to 500 characters", () => {
    expect(serverText("Something new.", "fr")).toBe("Something new.");
    expect(serverText("x".repeat(600), "fr")).toHaveLength(501);
  });
});

describe("server texts by code (R128)", () => {
  it("shows the text of a code in the session's language, filling its params", () => {
    const notice = {
      text: "Agent process exited with code 70.",
      code: "process_exit_code",
      params: { code: "70" },
    };
    expect(codedServerText(notice, "en")).toBe("Agent process exited with code 70.");
    expect(codedServerText(notice, "fr")).toBe("Le processus de l'agent s'est arrêté avec le code 70.");
    expect(
      codedServerText(
        { text: "This project already has 1000 ...", code: "rules_full", params: { max: "1000" } },
        "fr",
      ),
    ).toContain("1000");
  });

  it("prefers the code over the text: a reworded English sentence is still translated", () => {
    expect(codedServerText({ text: "Reworded in a later daemon.", code: "extension_failed" }, "fr")).toBe(
      "Une extension a échoué.",
    );
  });

  it("shows the English text as sent for a code it does not know, even when the text matches a pattern", () => {
    expect(codedServerText({ text: "Brand new sentence.", code: "from_the_future" }, "fr")).toBe(
      "Brand new sentence.",
    );
    expect(codedServerText({ text: "An extension failed.", code: "from_the_future" }, "fr")).toBe(
      "An extension failed.",
    );
  });

  it("falls back on the patterns for an event with no code", () => {
    expect(codedServerText({ text: "An extension failed." }, "fr")).toBe("Une extension a échoué.");
    expect(codedServerText({ text: "Something new." }, "fr")).toBe("Something new.");
  });

  it("has an English and a French sentence for every code the contract lists, with the same slots", () => {
    for (const code of Object.values(SERVER_CODES)) {
      const probe = {
        text: "UNTRANSLATED",
        code,
        params: { code: "1", signal: "SIGX", event: "e", count: "2", max: "3" },
      };
      const en = codedServerText(probe, "en");
      const fr = codedServerText(probe, "fr");
      expect(en, code).not.toBe("UNTRANSLATED");
      expect(fr, code).not.toBe("UNTRANSLATED");
      expect(en, code).not.toMatch(/[{}]/);
      expect(fr, code).not.toMatch(/[{}]/);
    }
  });
});
