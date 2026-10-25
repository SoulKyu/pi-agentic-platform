// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_KEY, BOOT_VAR_NAMES } from "./apply.ts";
import { APPEARANCE_ATTRS, DEFAULT_ACCOUNT, DEFAULT_DEVICE, toBootCache } from "./model.ts";
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

  it("paints the default density on a first visit, with nothing stored", () => {
    run();
    expect(DEFAULT_DEVICE.density).toBe("mixed");
    expect(root.dataset.density).toBe("mixed");
  });

  it("replays data-prose before paint", () => {
    localStorage.setItem(
      BOOT_KEY,
      JSON.stringify({
        ...toBootCache(DEFAULT_ACCOUNT, { ...DEFAULT_DEVICE, proseMeasure: "full" }),
      }),
    );
    run();
    expect(root.dataset.prose).toBe("full");
  });

  it("carries exactly the variable names the app writes", () => {
    const listed = /var allowed =\s*"([^"]+)"/.exec(source)?.[1]?.split(" ") ?? [];
    expect(listed.map((name) => `--${name}`).sort()).toEqual([...BOOT_VAR_NAMES].sort());
  });

  it("carries exactly the attribute names the app writes, besides the theme", () => {
    const listed = [...(/var names = \[([^\]]+)\]/.exec(source)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect([...listed].sort()).toEqual(APPEARANCE_ATTRS.filter((name) => name !== "theme").sort());
  });

  it("replays a stored cache with a custom theme: every cache variable ends up inline, tints included", () => {
    const ocean = {
      id: "ocean",
      name: "Ocean",
      base: "night",
      roles: {
        bg: "#0e1626",
        surface: "#132033",
        text: "#e6edf7",
        agent: "#38bdf8",
        you: "#fb923c",
        attn: "#ec4899",
        ok: "#34d399",
        err: "#f87171",
      },
    } as const;
    const device = { ...DEFAULT_DEVICE, uiSize: 15, chatSize: 16, codeSize: 13 };
    const cache = toBootCache(
      { ...DEFAULT_ACCOUNT, mode: "night", darkTheme: "ocean", customThemes: [ocean] },
      device,
    );
    localStorage.setItem(BOOT_KEY, JSON.stringify(cache));
    run();
    const expected = { ...cache.vars, ...cache.dark.vars };
    expect(Object.keys(expected).length).toBeGreaterThan(30);
    expect(Object.values(expected).some((value) => /^#[0-9a-f]{8}$/i.test(value))).toBe(true);
    const actual = Object.fromEntries(
      Object.keys(expected).map((name) => [name, root.style.getPropertyValue(name)]),
    );
    expect(actual).toEqual(expected);
    expect(root.dataset.theme).toBe("night");
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
    expect(root.dataset.density).toBe(DEFAULT_DEVICE.density);
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
