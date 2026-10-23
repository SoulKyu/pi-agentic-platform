import { describe, expect, it } from "vitest";
import { knowledgeEn, knowledgeFr } from "./catalog/knowledge.ts";

describe("catalog (OKF knowledge)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(knowledgeFr)).toEqual(Object.keys(knowledgeEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(knowledgeEn) as Array<keyof typeof knowledgeEn>) {
      expect(slots(knowledgeFr[key]), key).toEqual(slots(knowledgeEn[key]));
    }
  });

  it("carries the exact words", () => {
    expect([knowledgeEn["knowledge.chip.on"], knowledgeEn["knowledge.chip.off"]]).toEqual(["OKF", "NO OKF"]);
    expect([knowledgeFr["knowledge.chip.on"], knowledgeFr["knowledge.chip.off"]]).toEqual([
      "OKF",
      "SANS OKF",
    ]);
    expect(knowledgeEn["knowledge.row.enable"]).toBe("ENABLE OKF");
    expect(knowledgeFr["knowledge.row.enable"]).toBe("ACTIVER OKF");
    expect(knowledgeFr["knowledge.chip.pending"]).toBe(
      "OKF activé ; il s'applique au prochain démarrage de cette session",
    );
  });
});
