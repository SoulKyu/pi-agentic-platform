// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { applyAppearance, BOOT_KEY, inlineAppearanceVars, syncThemeColor, writeBootCache } from "./apply.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE, resolveAppearance, toBootCache } from "./model.ts";

const frames = () => {
  let next = 0;
  let queue = new Map<number, () => void>();
  return {
    request: (fn: () => void) => (queue.set(++next, fn), next),
    cancel: (id: number) => void queue.delete(id),
    /** Runs the frames requested so far (those they request wait for the next flush). */
    flush: () => {
      const due = [...queue.values()];
      queue = new Map();
      due.forEach((fn) => fn());
    },
  };
};

describe("applyAppearance", () => {
  it("sets every attribute, swaps variables and lifts the transition guard two frames later", () => {
    const root = document.createElement("html");
    const f = frames();
    const first = applyAppearance(
      root,
      resolveAppearance(DEFAULT_ACCOUNT, { ...DEFAULT_DEVICE, uiSize: 15 }, false),
      new Set(),
      f,
    );
    expect([root.dataset.theme, root.dataset.density, root.style.getPropertyValue("--size-ui")]).toEqual([
      "night",
      "mixed",
      "15px",
    ]);
    expect(root.classList.contains("theme-swap")).toBe(true);
    f.flush();
    expect(root.classList.contains("theme-swap")).toBe(true);
    f.flush();
    expect(root.classList.contains("theme-swap")).toBe(false);
    applyAppearance(root, resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false), first, f);
    expect(root.style.getPropertyValue("--size-ui")).toBe("");
  });

  it("a second change cancels the first one's frames, so the guard lasts two frames from the last change", () => {
    const root = document.createElement("html");
    const f = frames();
    const resolved = resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false);
    applyAppearance(root, resolved, new Set(), f);
    f.flush();
    applyAppearance(root, resolved, new Set(), f);
    f.flush();
    expect(root.classList.contains("theme-swap")).toBe(true);
    f.flush();
    expect(root.classList.contains("theme-swap")).toBe(false);
  });

  it("finds the appearance variables already set inline, and only those", () => {
    const root = document.createElement("html");
    root.style.setProperty("--bg", "#000000");
    root.style.setProperty("--size-ui", "15px");
    root.style.setProperty("--app-viewport-height", "400px");
    expect([...inlineAppearanceVars(root)].sort()).toEqual(["--bg", "--size-ui"]);
  });

  it("boot-set variables the app does not resolve are removed on the first apply", () => {
    const root = document.createElement("html");
    root.style.setProperty("--size-ui", "15px");
    root.style.setProperty("--bg", "#000000");
    root.style.setProperty("--app-viewport-height", "400px");
    applyAppearance(
      root,
      resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false),
      inlineAppearanceVars(root),
      frames(),
    );
    expect(root.style.getPropertyValue("--size-ui")).toBe("");
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("400px");
  });

  it("writes the boot cache and survives a storage that refuses", () => {
    const stored: Record<string, string> = {};
    writeBootCache({ setItem: (k, v) => void (stored[k] = v) }, toBootCache(DEFAULT_ACCOUNT, DEFAULT_DEVICE));
    expect(JSON.parse(stored[BOOT_KEY] ?? "{}").v).toBe(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        writeBootCache(
          {
            setItem: () => {
              throw new Error("quota");
            },
          },
          toBootCache(DEFAULT_ACCOUNT, DEFAULT_DEVICE),
        ),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith("pap: boot_cache_refused");
    } finally {
      warn.mockRestore();
    }
  });

  it("copies the side bar colour to theme-color, and ignores anything that is not a hex colour", () => {
    const root = document.documentElement;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#14111d");
    document.head.append(meta);
    root.style.setProperty("--bg-side", " #0e1626 ");
    syncThemeColor(root);
    expect(meta.getAttribute("content")).toBe("#0e1626");
    root.style.setProperty("--bg-side", "url(x)");
    syncThemeColor(root);
    expect(meta.getAttribute("content")).toBe("#0e1626");
    root.style.removeProperty("--bg-side");
    meta.remove();
  });
});
