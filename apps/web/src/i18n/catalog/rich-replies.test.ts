import { describe, expect, it } from "vitest";
import { richRepliesEn, richRepliesFr } from "./rich-replies.ts";

describe("catalog (rich replies)", () => {
  it("EN and FR have the same keys and slots", () => {
    expect(Object.keys(richRepliesFr)).toEqual(Object.keys(richRepliesEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(richRepliesEn) as Array<keyof typeof richRepliesEn>) {
      expect(slots(richRepliesFr[key]), key).toEqual(slots(richRepliesEn[key]));
    }
  });

  it("names the diagram label PF-9 asks for", () => {
    expect(richRepliesEn["reply.rich.diagram"]).toBe("Diagram");
    expect(richRepliesFr["reply.rich.diagram"]).toBe("Diagramme");
  });

  it("matches the plan's copy table word for word", () => {
    expect(richRepliesEn["reply.rich.artifactFrame"]).toBe("UNTRUSTED · html from the reply");
    expect(richRepliesFr["reply.rich.artifactFrame"]).toBe("NON FIABLE · html de la réponse");
    expect(richRepliesEn["reply.rich.artifactTitle"]).toBe("HTML preview");
    expect(richRepliesFr["reply.rich.artifactTitle"]).toBe("Aperçu HTML");
    expect(richRepliesEn["reply.rich.mermaidError"]).toBe("This diagram could not be drawn.");
    expect(richRepliesFr["reply.rich.mermaidError"]).toBe("Ce diagramme n'a pas pu être dessiné.");
    expect(richRepliesEn["reply.rich.mermaidTooLarge"]).toBe("This diagram is too large to draw here.");
    expect(richRepliesFr["reply.rich.mermaidTooLarge"]).toBe(
      "Ce diagramme est trop grand pour être dessiné ici.",
    );
  });
});
