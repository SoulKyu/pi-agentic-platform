import { describe, expect, it } from "vitest";
import { replyToolsEn, replyToolsFr } from "./catalog/reply-tools.ts";

describe("catalog (reply tools)", () => {
  it("EN and FR have the same keys and slots, and the exact words of Exact copy", () => {
    expect(Object.keys(replyToolsFr)).toEqual(Object.keys(replyToolsEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(replyToolsEn) as Array<keyof typeof replyToolsEn>) {
      expect(slots(replyToolsFr[key]), key).toEqual(slots(replyToolsEn[key]));
    }
    expect(replyToolsEn["reply.path.open"]).toBe("Open {path} in Files");
    expect(replyToolsFr["reply.path.open"]).toBe("Ouvrir {path} dans Fichiers");
    expect(replyToolsEn["reply.meter.context"]).toBe("{used} / {window} tokens");
    expect(replyToolsFr["reply.meter.context"]).toBe("{used} / {window} jetons");
    expect(replyToolsEn["reply.meter.label"]).toBe("Context");
    expect(replyToolsFr["reply.meter.label"]).toBe("Contexte");
    expect(replyToolsEn["reply.meter.soon"]).toBe("compaction soon");
    expect(replyToolsFr["reply.meter.soon"]).toBe("compaction bientôt");
    expect(replyToolsEn["reply.meter.session"]).toBe("Session {cost}");
    expect(replyToolsFr["reply.meter.session"]).toBe("Session {cost}");
    expect(replyToolsEn["reply.meter.run"]).toBe("run {cost}");
    expect(replyToolsFr["reply.meter.run"]).toBe("exécution {cost}");
    expect(replyToolsEn["reply.meter.apiEquivalent"]).toBe("API-equivalent");
    expect(replyToolsFr["reply.meter.apiEquivalent"]).toBe("équivalent API");
  });
});
