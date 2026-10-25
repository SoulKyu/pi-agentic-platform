import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESET_TOKENS } from "./presets.ts";
import { THEME_TOKENS, THEMES, type ThemeName } from "./token-names.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
const utilities = readFileSync(new URL("./utilities.css", import.meta.url), "utf8");

interface Block {
  readonly media: string | null;
  readonly selector: string;
  readonly decls: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Top-level rules and the rules of @media blocks, comments removed. Enough for a hand-written token file. */
function parse(source: string): Block[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const walk = (src: string, media: string | null): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open === -1) return;
      const raw = src.slice(i, open);
      const prelude = raw
        .slice(raw.lastIndexOf(";") + 1)
        .trim()
        .replace(/\s+/g, " ");
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else {
        const decls = new Map<string, string>();
        for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
          decls.set(m[1] ?? "", (m[2] ?? "").trim().toLowerCase());
        out.push({ media, selector: prelude, decls, body });
      }
      i = j;
    }
  };
  walk(text, null);
  return out;
}

// WCAG 2.x contrast, with a translucent colour composited over its backdrop (the token tests' own copy; the app's
// contrast.ts arrives in Task 13).
const channels = (hex: string): number[] =>
  [1, 3, 5, 7].filter((i) => i < hex.length).map((i) => parseInt(hex.slice(i, i + 2), 16));
function over(color: string, backdrop: string): string {
  const [r = 0, g = 0, b = 0, a = 255] = channels(color);
  const [br = 0, bg = 0, bb = 0] = channels(backdrop);
  const mix = (c: number, d: number) => Math.round(c * (a / 255) + d * (1 - a / 255));
  return `#${[mix(r, br), mix(g, bg), mix(b, bb)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const blocks = parse(css);
const themeBlocks = blocks.filter((block) => block.decls.has("--bg"));
const PER_THEME = [...THEME_TOKENS.map((name) => `--${name}`), "--shadow-overlay"];

describe("theme tokens (DESIGN.md §3)", () => {
  it("sets theme values only from equal-specificity selectors, plus a no-JS fallback (R120)", () => {
    expect(themeBlocks.map((block) => `${block.media ?? ""}|${block.selector}`)).toEqual([
      '|:root, [data-theme="night"]',
      '|[data-theme="day"]',
      '|[data-theme="hc"]',
      "@media (prefers-color-scheme: light)|:root:not([data-theme])",
    ]);
    for (const block of themeBlocks) expect(block.body).not.toContain("!important");
  });

  it("defines every token in every theme", () => {
    for (const block of themeBlocks)
      for (const name of PER_THEME) expect(block.decls.has(name), `${block.selector} ${name}`).toBe(true);
  });

  it("matches the presets, and the fallback is the day theme", () => {
    const [night, day, hc, fallback] = themeBlocks;
    for (const name of THEME_TOKENS) {
      expect(night?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.night[name]);
      expect(day?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.day[name]);
      expect(hc?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.hc[name]);
      expect(fallback?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.day[name]);
    }
  });

  it("keeps the decision 11 role colours", () => {
    for (const hex of [
      "#110f18",
      "#a78bfa",
      "#fb923c",
      "#ec4899",
      "#faf9f6",
      "#6d28d9",
      "#c2410c",
      "#be185d",
    ]) {
      expect(css.toLowerCase()).toContain(hex);
    }
  });

  it("applies ADR 0012's values (R120)", () => {
    const pick = (token: "focus-ring" | "control-border" | "attn-title" | "attn-ink") =>
      THEMES.map((theme) => PRESET_TOKENS[theme][token]);
    expect(pick("focus-ring")).toEqual(["#fb923c", "#c2410c", "#fb923c"]);
    expect(pick("control-border")).toEqual(["#6b6485", "#8f877a", "#8a8a8a"]);
    expect(pick("attn-title")).toEqual(["#f472b6", "#be185d", "#f9a8d4"]);
    expect(pick("attn-ink")).toEqual(["#110f18", "#ffffff", "#110f18"]);
    expect(PRESET_TOKENS.night.border).toBe("#2d2840"); // the hairline stays decorative
  });

  it.each(THEMES)("reaches the ratios ADR 0012 promises in %s", (theme: ThemeName) => {
    const t = PRESET_TOKENS[theme];
    for (const ground of [t.bg, t.surface]) {
      expect(ratio(t["focus-ring"], ground), `focus ring on ${ground}`).toBeGreaterThanOrEqual(3);
      expect(ratio(t["control-border"], ground), `control border on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    expect(
      ratio(t["attn-title"], over(t["attn-tint"], t.surface)),
      "approval title on its card",
    ).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["attn-ink"], t["attn-fill"]), "ink on the attention fill").toBeGreaterThanOrEqual(4.5);
  });

  it("the focus ring reaches 3:1 on bg, surface and surface-2 in every theme", () => {
    for (const theme of THEMES) {
      const t = PRESET_TOKENS[theme];
      for (const ground of [t.bg, t.surface, t["surface-2"]]) {
        expect(ratio(t["focus-ring"], ground), `${theme} ring on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("placeholders use text-muted at 4.5:1 on bg and surface in every theme", () => {
    expect(utilities).toMatch(/::placeholder \{\s*color: var\(--text-muted\);\s*opacity: 1;\s*\}/);
    for (const theme of THEMES) {
      const t = PRESET_TOKENS[theme];
      for (const ground of [t.bg, t.surface]) {
        expect(ratio(t["text-muted"], ground), `${theme} placeholder on ${ground}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("the ratios this plan quotes stay true", () => {
    const day = PRESET_TOKENS.day;
    expect(ratio("#c2410c", day.bg)).toBeCloseTo(4.92, 2);
    expect(ratio("#c2410c", day.surface)).toBeCloseTo(5.18, 2);
    expect(ratio("#c2410c", day["surface-2"])).toBeCloseTo(4.35, 2);
    expect(ratio(day["text-muted"], day.bg)).toBeCloseTo(5.55, 2);
    expect(ratio(day["text-muted"], day.surface)).toBeCloseTo(5.84, 2);
  });

  it("measures what ADR 0012 records, so its numbers stay true", () => {
    expect(ratio("#ea580c", "#faf9f6")).toBeCloseTo(3.38, 2); // the Day ring before A2
    expect(ratio("#8f877a", "#faf9f6")).toBeCloseTo(3.37, 2);
    expect(ratio("#6b6485", "#1a1724")).toBeCloseTo(3.18, 2);
    expect(ratio("#f472b6", over("#ec48991a", "#1a1724"))).toBeCloseTo(5.96, 2);
    expect(ratio("#110f18", "#ec4899")).toBeCloseTo(5.39, 2);
    expect(ratio("#fb923c", "#faf9f6")).toBeCloseTo(2.15, 2); // why the day ring changed
  });

  it("gives each role its own ink", () => {
    expect(PRESET_TOKENS.night["agent-ink"]).toBe("#110f18");
    expect(PRESET_TOKENS.day["agent-ink"]).toBe("#ffffff");
    expect(PRESET_TOKENS.night["you-ink"]).toBe("#1b0d00");
  });

  it("has no M1 alias left: every colour utility is a DESIGN name", () => {
    const names = [...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]);
    for (const alias of [
      "panel",
      "line",
      "human",
      "human-fill",
      "human-tint",
      "human-line",
      "human-text",
      "on-fill",
      "attention",
      "attention-tint",
      "attention-line",
      "error",
    ]) {
      expect(names, alias).not.toContain(alias);
    }
    expect(css).not.toContain("M1 names");
    expect(names).toEqual(
      expect.arrayContaining(["fg", "muted", "surface", "border", "you-fill", "attn", "err"]),
    );
  });

  it("resets the default Tailwind palette before the first colour", () => {
    const reset = css.indexOf("--color-*: initial;");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(css.indexOf("--color-bg:"));
  });

  it("turns the grid off after the themes, so it wins over them", () => {
    const off = blocks.findIndex((block) => block.selector === '[data-grid="off"]');
    expect(off).toBeGreaterThan(blocks.indexOf(themeBlocks[2] as Block));
  });

  it("keeps both files within the 400-line rule (AGENTS.md)", () => {
    expect(css.split("\n").length).toBeLessThanOrEqual(400);
    expect(utilities.split("\n").length).toBeLessThanOrEqual(400);
  });
});

describe("densities (DESIGN.md §5)", () => {
  const density = (selector: string) => blocks.find((block) => block.selector === selector)?.decls;

  it("sizes compact, comfortable and mixed as the table says", () => {
    const compact = density(':root, [data-density="compact"]');
    const comfortable = density('[data-density="comfortable"]');
    const mixed = density('[data-density="mixed"]');
    expect([
      compact?.get("--size-ui"),
      compact?.get("--size-chat"),
      compact?.get("--leading-chat"),
      compact?.get("--size-code"),
    ]).toEqual(["13px", "14px", "1.55", "12px"]);
    expect([
      comfortable?.get("--size-ui"),
      comfortable?.get("--size-chat"),
      comfortable?.get("--leading-chat"),
      comfortable?.get("--size-code"),
    ]).toEqual(["14px", "15px", "1.65", "12.5px"]);
    expect([mixed?.get("--size-ui"), mixed?.get("--size-chat"), mixed?.get("--leading-chat")]).toEqual([
      "13px",
      "15px",
      "1.65",
    ]);
    expect([
      compact?.get("--control-h"),
      compact?.get("--rail-w"),
      compact?.get("--bar-h"),
      compact?.get("--avatar-size"),
    ]).toEqual(["26px", "48px", "34px", "28px"]);
    expect([
      comfortable?.get("--control-h"),
      comfortable?.get("--rail-w"),
      comfortable?.get("--bar-h"),
      comfortable?.get("--avatar-size"),
    ]).toEqual(["32px", "56px", "40px", "32px"]);
    expect([1, 2, 3, 4, 5, 6].map((n) => compact?.get(`--space-${n}`))).toEqual([
      "4px",
      "8px",
      "12px",
      "16px",
      "24px",
      "32px",
    ]);
    expect([1, 2, 3, 4, 5, 6].map((n) => comfortable?.get(`--space-${n}`))).toEqual([
      "6px",
      "10px",
      "16px",
      "24px",
      "32px",
      "48px",
    ]);
  });

  it("text-label is 11 px", () => {
    const theme = blocks.find((block) => block.selector === "@theme inline");
    expect(theme?.decls.get("--text-label")).toBe("0.6875rem");
    expect(theme?.decls.get("--tracking-label")).toBe("0.08em");
  });
});

describe("motion, labels and fonts", () => {
  it("drops transitions to 0 ms for reduced and none, and for system under prefers-reduced-motion", () => {
    expect(
      blocks
        .find((b) => b.selector === '[data-motion="reduced"], [data-motion="none"]')
        ?.decls.get("--motion-base"),
    ).toBe("0ms");
    const system = blocks.find(
      (b) =>
        b.media === "@media (prefers-reduced-motion: reduce)" &&
        b.selector.includes('[data-motion="system"]'),
    );
    expect(system?.decls.get("--motion-fast")).toBe("0ms");
  });

  it("stops the indeterminate bar under reduced motion", () => {
    expect(utilities).toContain('[data-motion="none"] .animate-indeterminate');
    expect(utilities).toContain('[data-motion="system"] .animate-indeterminate');
  });

  it("stops spinners as well as the indeterminate bar under reduced motion", () => {
    expect(utilities).toContain('[data-motion="none"] .animate-spin');
    expect(utilities).toContain('[data-motion="system"] .animate-spin');
    expect(utilities).toMatch(/\[data-motion="none"\] \.animate-spin \{\s*animation: none;/);
  });

  it("switches HUD labels to sentence case with one attribute", () => {
    expect(
      blocks.find((b) => b.selector === '[data-labels="sentence"]')?.decls.get("--label-transform"),
    ).toBe("none");
  });

  it('the prose measure is 72ch on :root and none under data-prose="full"', () => {
    const root = blocks.filter((b) => b.selector === ":root").find((b) => b.decls.has("--prose-measure"));
    expect(root?.decls.get("--prose-measure")).toBe("72ch");
    expect(blocks.find((b) => b.selector === '[data-prose="full"]')?.decls.get("--prose-measure")).toBe(
      "none",
    );
  });

  it("serves its own woff2 files", () => {
    expect(fonts).not.toMatch(/https?:\/\//);
    expect(fonts).toContain("font-display: swap");
    const files = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(files).toHaveLength(4);
    for (const file of files)
      expect(existsSync(new URL(file, new URL("./fonts.css", import.meta.url))), file).toBe(true);
  });

  it("loads nothing from the network", () => {
    for (const source of [css, utilities]) expect(source).not.toMatch(/url\(|@import|https?:\/\//);
  });
});
