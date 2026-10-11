import { describe, expect, it } from "vitest";
import { serverText } from "./server-text.ts";

describe("server texts (R128)", () => {
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
  ])("translates %s", (english, french) => {
    expect(serverText(english, "en")).toBe(english);
    expect(serverText(english, "fr")).toBe(french);
  });

  it("shows an unknown sentence as sent, clipped to 500 characters", () => {
    expect(serverText("Something new.", "fr")).toBe("Something new.");
    expect(serverText("x".repeat(600), "fr")).toHaveLength(501);
  });
});
