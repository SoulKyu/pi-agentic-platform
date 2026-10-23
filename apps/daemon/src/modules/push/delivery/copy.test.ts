import { describe, expect, it } from "vitest";
import { WIRE_CLASSES } from "@pap/contracts";
import { copyFor } from "./copy.ts";

describe("copyFor", () => {
  it("uses the title pap and fixed generic sentences", () => {
    expect(copyFor("approval", "en")).toEqual({
      title: "pap",
      body: "A request is waiting for your answer.",
    });
    expect(copyFor("approval", "fr")).toEqual({ title: "pap", body: "Une demande attend votre réponse." });
    expect(copyFor("failed", "en").body).toBe("A task did not finish.");
    expect(copyFor("failed", "fr").body).toBe("Une tâche ne s'est pas terminée.");
    expect(copyFor("budget", "en").body).toBe("A budget is reached.");
    expect(copyFor("budget", "fr").body).toBe("Un budget est atteint.");
    expect(copyFor("notify", "en").body).toBe("An agent has a message for you.");
    expect(copyFor("notify", "fr").body).toBe("Un agent a un message pour vous.");
    expect(copyFor("test", "en").body).toBe("Test notification.");
    expect(copyFor("test", "fr").body).toBe("Notification de test.");
  });

  it("has its own sentence for done and reply", () => {
    for (const locale of ["en", "fr"] as const) {
      const bodies = (["done", "reply"] as const).map((c) => copyFor(c, locale).body);
      expect(new Set(bodies).size).toBe(2);
      for (const body of bodies) expect(body.length).toBeGreaterThan(5);
    }
  });

  it("never leaves a placeholder and always fits the wire limits", () => {
    for (const cls of WIRE_CLASSES)
      for (const locale of ["en", "fr"] as const) {
        const { title, body } = copyFor(cls, locale, { n: 3, expired: 2, name: "Agent" });
        expect(`${title}${body}`).not.toMatch(/[{}]/);
        expect(title).toBe("pap");
        expect(body.length).toBeLessThanOrEqual(200);
      }
  });

  it("addresses the owner with vous in French", () => {
    for (const cls of WIRE_CLASSES) {
      const { body } = copyFor(cls, "fr", { n: 2, expired: 1 });
      expect(body).not.toMatch(/\b(tu|ton|ta|tes|toi|te)\b/i);
    }
  });

  describe("digest", () => {
    it("counts the items", () => {
      expect(copyFor("digest", "en", { n: 3 }).body).toBe("3 items are waiting for you.");
      expect(copyFor("digest", "fr", { n: 3 }).body).toBe("3 éléments vous attendent.");
    });
    it("uses the singular for one item and one expired request", () => {
      expect(copyFor("digest", "en", { n: 1 }).body).toBe("1 item is waiting for you.");
      expect(copyFor("digest", "fr", { n: 1 }).body).toBe("1 élément vous attend.");
      expect(copyFor("digest", "en", { n: 0, expired: 1 }).body).toBe(
        "1 request expired during quiet hours.",
      );
      expect(copyFor("digest", "fr", { n: 0, expired: 1 }).body).toBe(
        "1 demande a expiré pendant les heures calmes.",
      );
      expect(copyFor("digest", "en", { n: 1, expired: 1 }).body).toBe(
        "1 item is waiting for you. 1 request expired during quiet hours.",
      );
      expect(copyFor("digest", "fr", { n: 1, expired: 1 }).body).toBe(
        "1 élément vous attend. 1 demande a expiré pendant les heures calmes.",
      );
    });
    it("adds the expired sentence", () => {
      expect(copyFor("digest", "en", { n: 3, expired: 2 }).body).toBe(
        "3 items are waiting for you. 2 requests expired during quiet hours.",
      );
      expect(copyFor("digest", "fr", { n: 3, expired: 2 }).body).toBe(
        "3 éléments vous attendent. 2 demandes ont expiré pendant les heures calmes.",
      );
    });
    it("reads only the expired sentence with no item", () => {
      expect(copyFor("digest", "en", { n: 0, expired: 2 }).body).toBe(
        "2 requests expired during quiet hours.",
      );
      expect(copyFor("digest", "fr", { n: 0, expired: 2 }).body).toBe(
        "2 demandes ont expiré pendant les heures calmes.",
      );
    });
    it("never carries a name", () => {
      expect(copyFor("digest", "en", { n: 1, name: "Nightly" }).body).not.toContain("Nightly");
      expect(copyFor("test", "en", { name: "Nightly" }).body).not.toContain("Nightly");
    });
  });

  describe("names", () => {
    it("appends the name after a dash", () => {
      expect(copyFor("failed", "en", { name: "Nightly" }).body).toBe("A task did not finish. - Nightly");
    });
    it("strips controls, bidi and zero-width characters", () => {
      const body = copyFor("failed", "en", { name: "Ni\u202eght\u200bly\u0007\n\u2028\u2029" }).body;
      expect(body).toBe("A task did not finish. - Nightly");
    });
    it("cuts at 60 code points without splitting a pair", () => {
      const name = "\u{1F600}".repeat(70);
      const body = copyFor("failed", "en", { name }).body;
      expect(Array.from(body.slice("A task did not finish. - ".length))).toHaveLength(60);
    });
    it("stays generic when nothing is left of the name", () => {
      expect(copyFor("failed", "en", { name: "\u202e\u200b" }).body).toBe("A task did not finish.");
      expect(copyFor("failed", "en", { name: "" }).body).toBe("A task did not finish.");
    });
  });
});
