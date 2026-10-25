import { describe, expect, it } from "vitest";
import { frenchSpacing } from "./fr-spacing.ts";

const NNBSP = " ";

describe("frenchSpacing", () => {
  it("puts U+202F before ? ! : ; » and after «, and leaves URLs, times and {placeholders} alone", () => {
    expect(frenchSpacing("Vraiment ? Oui !")).toBe(`Vraiment${NNBSP}? Oui${NNBSP}!`);
    expect(frenchSpacing("Note : un ; deux")).toBe(`Note${NNBSP}: un${NNBSP}; deux`);
    expect(frenchSpacing("« Fermer »")).toBe(`«${NNBSP}Fermer${NNBSP}»`);
    expect(frenchSpacing("Voir https://exemple.fr/a?b=1 ici")).toBe("Voir https://exemple.fr/a?b=1 ici");
    expect(frenchSpacing("À 12:30 et 9:05")).toBe("À 12:30 et 9:05");
    expect(frenchSpacing("{count} : {name} ?")).toBe(`{count}${NNBSP}: {name}${NNBSP}?`);
    expect(frenchSpacing("Ouvrez `a ? b : c` puis : ok")).toBe(`Ouvrez \`a ? b : c\` puis${NNBSP}: ok`);
  });

  it("replaces a plain or no-break space and leaves a value without punctuation alone", () => {
    expect(frenchSpacing("Quoi ?")).toBe(`Quoi${NNBSP}?`);
    expect(frenchSpacing("Bonjour")).toBe("Bonjour");
    expect(frenchSpacing("hôte:9090 et a:b")).toBe("hôte:9090 et a:b");
  });
});
