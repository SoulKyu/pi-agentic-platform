// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { syncFontLinks } from "./font-links.ts";

// happy-dom would fetch a linked stylesheet from localhost: no test touches a network.
const noCssLoading = () => {
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } };
    }
  ).happyDOM.settings;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
};

const hrefs = () =>
  [...document.head.querySelectorAll("link[data-pap-font]")].map((link) => link.getAttribute("href"));
beforeEach(() => {
  noCssLoading();
  document.head.innerHTML = "";
});

describe("syncFontLinks", () => {
  it("adds one same-origin stylesheet link per family, once", () => {
    syncFontLinks(document, ["inter"]);
    syncFontLinks(document, ["inter"]);
    expect(hrefs()).toEqual(["/fonts/inter/font.css"]);
    const link = document.head.querySelector("link[data-pap-font]") as HTMLLinkElement;
    expect(link.rel).toBe("stylesheet");
    expect(link.getAttribute("href")?.startsWith("/")).toBe(true);
  });

  it("removes the link of a family no longer in use and leaves other links alone", () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/assets/app.css">';
    syncFontLinks(document, ["inter", "fira-code"]);
    expect(hrefs()).toEqual(["/fonts/inter/font.css", "/fonts/fira-code/font.css"]);
    syncFontLinks(document, ["fira-code"]);
    expect(hrefs()).toEqual(["/fonts/fira-code/font.css"]);
    syncFontLinks(document, []);
    expect(hrefs()).toEqual([]);
    expect(document.head.querySelector('link[href="/assets/app.css"]')).not.toBeNull();
  });

  it("ignores a slug that is not a plain slug", () => {
    syncFontLinks(document, ["../x", "a/b", "inter"]);
    expect(hrefs()).toEqual(["/fonts/inter/font.css"]);
  });
});
