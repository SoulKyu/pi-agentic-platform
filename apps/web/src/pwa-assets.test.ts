import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const webRoot = resolve(import.meta.dirname, "..");
const publicDir = resolve(webRoot, "public");
const html = readFileSync(resolve(webRoot, "index.html"), "utf8");
const tokens = readFileSync(resolve(webRoot, "../../packages/ui/src/tokens.css"), "utf8");

const Icon = z.object({
  src: z.string().regex(/^\/icons\/[a-z0-9-]+\.png$/),
  sizes: z.string().regex(/^\d+x\d+$/),
  type: z.literal("image/png"),
  purpose: z.enum(["any", "maskable"]),
});
const Manifest = z.strictObject({
  id: z.literal("/"),
  name: z.literal("pap"),
  short_name: z.literal("pap"),
  start_url: z.literal("/"),
  scope: z.literal("/"),
  display: z.literal("standalone"),
  background_color: z.string().regex(/^#[0-9a-f]{6}$/),
  theme_color: z.string().regex(/^#[0-9a-f]{6}$/),
  icons: z.array(Icon),
});

const manifest = () =>
  Manifest.parse(JSON.parse(readFileSync(resolve(publicDir, "manifest.webmanifest"), "utf8")));

// PNG header: 8 signature bytes, then the IHDR chunk (length, "IHDR", width, height).
const pngSize = (path: string): string => {
  const head = readFileSync(resolve(publicDir, path)).subarray(0, 24);
  expect(head.subarray(0, 8).toString("hex"), path).toBe("89504e470d0a1a0a");
  expect(head.subarray(12, 16).toString("ascii"), path).toBe("IHDR");
  return `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
};

describe("web app manifest (M12R27)", () => {
  it("declares the installable shell with the any and maskable icons", () => {
    const icons = manifest().icons;
    expect(icons.map(({ sizes, purpose }) => `${sizes} ${purpose}`)).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
  });

  it("points every icon at a PNG whose real size equals the declared size", () => {
    for (const icon of manifest().icons) expect(pngSize(icon.src.slice(1)), icon.src).toBe(icon.sizes);
  });

  it("keeps the maskable icon square and the badge and apple icons at their sizes", () => {
    const [width, height] = pngSize("icons/icon-maskable-512.png").split("x");
    expect(width).toBe(height);
    expect(pngSize("icons/badge-96.png")).toBe("96x96");
    expect(pngSize("icons/apple-touch-icon.png")).toBe("180x180");
  });

  it("uses the night side colour of the theme and the HTML theme-color meta", () => {
    const night = /\[data-theme="night"\] \{[^}]*--bg-side: (#[0-9a-f]{6});/.exec(tokens)?.[1];
    const meta = /<meta name="theme-color" content="(#[0-9a-f]{6})"/.exec(html)?.[1];
    expect(night).toBeDefined();
    expect(manifest().theme_color).toBe(meta);
    expect(manifest().background_color).toBe(night);
    expect(manifest().theme_color).toBe(night);
  });
});

describe("index.html install tags", () => {
  it.each([
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="pap" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
  ])("has %s", (tag) => {
    expect(html).toContain(tag);
  });
});
