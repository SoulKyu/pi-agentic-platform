import { SERVER_CODES } from "@pap/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { serverEn, serverFr } from "./catalog/server.ts";
import { registerCatalog } from "./index.ts";
import { codedServerText, serverText, translatedServerCodes } from "./server-text.ts";

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
        params: {
          code: "1",
          signal: "SIGX",
          event: "e",
          count: "2",
          max: "3",
          model: "p/m",
          running: "q/n",
          extension: "x",
        },
      };
      const en = codedServerText(probe, "en");
      const fr = codedServerText(probe, "fr");
      expect(en, code).not.toBe("UNTRANSLATED");
      expect(fr, code).not.toBe("UNTRANSLATED");
      expect(en, code).not.toMatch(/[{}]/);
      expect(fr, code).not.toMatch(/[{}]/);
    }
  });

  it("pins the web table to the contract's list in both directions", () => {
    expect([...translatedServerCodes()].sort()).toEqual(Object.values(SERVER_CODES).sort());
  });

  it("shows the English text as sent when a known code lacks a param, never a raw slot", () => {
    expect(
      codedServerText(
        { text: "An extension failed during tool_call.", code: "extension_failed_during" },
        "fr",
      ),
    ).toBe("An extension failed during tool_call.");
    expect(
      codedServerText({ text: "x", code: "extension_failed_during", params: { other: "y" } }, "fr"),
    ).toBe("x");
  });

  it("never lets a code select a key outside the server texts", () => {
    for (const code of ["ui.close", "shell.tab.home", "server.cause.stopped"])
      expect(codedServerText({ text: "Sent as is.", code }, "fr")).toBe("Sent as is.");
  });

  it("says in French which saved model an agent's worker refused and what runs instead", () => {
    const params = { model: "claude-bridge/claude-opus-4", running: "anthropic/claude-sonnet-4-5" };
    const english =
      "This agent's model claude-bridge/claude-opus-4 is not offered to its worker: it runs on anthropic/claude-sonnet-4-5 instead. Settings › Models › Available models decides what is offered.";
    const french = codedServerText({ text: english, code: "agent_model_refused", params }, "fr");
    expect(french).toContain("Le modèle de cet agent, claude-bridge/claude-opus-4,");
    expect(french).toContain("avec anthropic/claude-sonnet-4-5 à la place");
    expect(french).toContain("Réglages › Modèles › Modèles proposés");
    // An older daemon's English sentence alone is matched too.
    expect(codedServerText({ text: english }, "fr")).toBe(french);
    expect(
      codedServerText({ text: "x", code: "agent_model_refused_default", params: { model: "p/m" } }, "en"),
    ).toContain("runs on Pi's default model instead");
  });

  it("names the extension in both languages, and says an override is not a failure", () => {
    const named = {
      text: "x",
      code: "extension_failed_named",
      params: { event: "session_start", extension: "pi-x" },
    };
    expect(codedServerText(named, "en")).toBe("The extension pi-x failed during session_start.");
    expect(codedServerText(named, "fr")).toBe("L'extension pi-x a échoué pendant session_start.");
    expect(serverText("An extension (pi-x) failed during tool_call.", "fr")).toBe(
      "L'extension pi-x a échoué pendant tool_call.",
    );
    const override = { text: "x", code: "extension_override" };
    expect(codedServerText(override, "en")).not.toMatch(/fail/i);
    expect(codedServerText(override, "fr")).toBe(
      "Une extension a enregistré un outil que pap fournit lui-même\u202f: l'outil de pap est celui utilisé.",
    );
  });

  it("puts params in as plain text, markup included", () => {
    const event = "<img src=x onerror=alert(1)>";
    expect(codedServerText({ text: "t", code: "extension_failed_during", params: { event } }, "fr")).toBe(
      `Une extension a échoué pendant ${event}.`,
    );
  });
});
