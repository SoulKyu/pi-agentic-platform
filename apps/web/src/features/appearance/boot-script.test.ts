// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_KEY, BOOT_VAR_NAMES } from "./apply.ts";
import source from "./boot-script.js?raw";
const run = () => new Function(source)();
const root = document.documentElement;

function setLight(light: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: light && query.includes("light"),
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  for (const name of [...root.getAttributeNames()]) if (name.startsWith("data-")) root.removeAttribute(name);
  root.removeAttribute("style");
  setLight(false);
});
afterEach(() => localStorage.clear());

describe("boot script (runs before the first paint)", () => {
  it("reads the same storage key the applier writes", () => {
    expect(source).toContain(JSON.stringify(BOOT_KEY));
  });

  it("replays attributes, variables and the side the system asks for", () => {
    localStorage.setItem(
      BOOT_KEY,
      JSON.stringify({
        v: 1,
        mode: "system",
        attrs: { density: "comfortable", labels: "sentence" },
        vars: { "--size-ui": "15px" },
        dark: { theme: "hc", vars: {} },
        light: { theme: "night", vars: { "--bg": "#0e1626" } },
      }),
    );
    run();
    expect([
      root.dataset.density,
      root.dataset.labels,
      root.dataset.theme,
      root.style.getPropertyValue("--size-ui"),
    ]).toEqual(["comfortable", "sentence", "hc", "15px"]);
    setLight(true);
    run();
    expect([root.dataset.theme, root.style.getPropertyValue("--bg")]).toEqual(["night", "#0e1626"]);
  });

  it("carries exactly the variable names the app writes", () => {
    const listed = /var allowed =\s*"([^"]+)"/.exec(source)?.[1]?.split(" ") ?? [];
    expect(listed.map((name) => `--${name}`).sort()).toEqual([...BOOT_VAR_NAMES].sort());
  });

  it("ignores garbage, unknown keys, unknown variables and throwing storage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(BOOT_KEY, "{oops");
    expect(run).not.toThrow();
    expect(warn).toHaveBeenCalledWith("pap: appearance_boot_failed");
    warn.mockRestore();
    localStorage.setItem(
      BOOT_KEY,
      JSON.stringify({
        v: 1,
        mode: "night",
        attrs: { onclick: "x", density: "<b>" },
        vars: {
          "--bg": "url(https://x.test)",
          color: "red",
          "--app-viewport-height": "1px",
          "--rail-w": "1px",
        },
        dark: { theme: "evil", vars: {} },
        light: { theme: "day", vars: {} },
      }),
    );
    run();
    expect(root.getAttribute("data-onclick")).toBeNull();
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(run).not.toThrow();
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});
