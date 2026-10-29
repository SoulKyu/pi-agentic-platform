import { describe, expect, it } from "vitest";
import { previewsEn, previewsFr } from "./catalog/previews.ts";
import { shellEn, shellFr } from "./catalog/shell.ts";

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const FAMILIAR = /(?<![\p{L}'])(tu|ton|ta|tes|te|toi)(?![\p{L}])/iu;

describe("catalog (previews)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(previewsFr)).toEqual(Object.keys(previewsEn));
    for (const key of Object.keys(previewsEn) as Array<keyof typeof previewsEn>)
      expect(slots(previewsFr[key]), key).toEqual(slots(previewsEn[key]));
  });

  it("carries the exact words of the pane, the strip and the states", () => {
    expect(previewsEn["previews.strip"]).toBe("Preview {name} · port {port}");
    expect(previewsFr["previews.strip"]).toBe("Aperçu {name} · port {port}");
    expect(previewsEn["previews.open"]).toBe("Open preview");
    expect(previewsEn["previews.frame"]).toBe("UNTRUSTED · preview {name}");
    expect(previewsFr["previews.frame"]).toBe("NON FIABLE · aperçu {name}");
    expect(previewsEn["previews.newTab"]).toBe("Open in a new tab");
    expect(previewsEn["previews.gone"]).toBe("This preview is not running. Ask the agent to start it again.");
    expect(previewsEn["previews.cookies"]).toBe(
      "Logins that use cookies or an Authorization header do not work in a preview.",
    );
    expect(previewsFr["previews.cookies"]).toBe(
      "Les connexions par cookie ou par en-tête Authorization ne fonctionnent pas dans un aperçu.",
    );
    expect(previewsEn["previews.notOpen"]).toBe("Open the preview to load the page.");
    expect(previewsEn["previews.restarted"]).toBe(
      "This preview restarted. Open it again to load the new page.",
    );
    expect(previewsEn["previews.declaredCommand"]).toBe("Runs {command}");
    expect(previewsEn["previews.changed"]).toBe(
      "The preview in .pi/project.yaml changed. Check the new command, then start it.",
    );
  });

  it("speaks to the owner with vous, and claims no safety", () => {
    for (const text of Object.values(previewsFr)) expect(text).not.toMatch(FAMILIAR);
    for (const text of Object.values(previewsEn)) expect(text).not.toMatch(/\b(isolated|safe|secure)\b/i);
  });

  it("keeps the words every shell surface needs (the tab, the phone entry) in the eager catalog", () => {
    expect(shellEn["previews.surface"]).toBe("Preview");
    expect(shellFr["previews.surface"]).toBe("Aperçu");
    expect(shellEn["shell.tab.preview"]).toBe("Preview {name}");
    expect(shellFr["shell.tab.preview"]).toBe("Aperçu {name}");
    expect(Object.keys(previewsEn)).not.toContain("previews.surface");
  });
});
