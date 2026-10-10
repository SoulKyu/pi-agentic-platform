// Usage: node scan.ts <path to a clone of vercel/ai-elements> > scan-results.json
// Static scan of every AI Elements component against our stack: what it imports,
// whether it needs the Vercel AI SDK, which Tailwind classes break our design rules,
// which CSS features sit above the Safari 16.4 floor, and the licence of each direct dependency.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scan.ts <ai-elements clone>");

const srcDir = join(root, "packages/elements/src");
const manifest = JSON.parse(readFileSync(join(root, "packages/elements/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|accent)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/g;
const HEX = /["'`\s]#[0-9a-fA-F]{3,8}\b/g;
const FUNCTIONAL = /\b(?:rgb|rgba|hsl|hsla|oklch)\(/g;
const ARBITRARY = /[\w:-]+-\[[^\]\s]+\]/g;
const ARBITRARY_VARIANT = /\[&[^\]\s]*\]:[\w-]+/g;
const ABOVE_FLOOR: Record<string, RegExp> = {
  "field-sizing (Safari 26)": /field-sizing/,
  "text-balance (Safari 17.5)": /text-balance/,
  "text-pretty (Safari 26)": /text-pretty/,
  "starting-style (Safari 17.5)": /starting:|@starting-style/,
  "light-dark() (Safari 17.5)": /light-dark\(/,
  "popover / anchor (Safari 17+)": /popover=|anchor-name|position-anchor/,
};
const SEMANTIC =
  /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via)-(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|input|ring|border)(?=[\s"'\`/:)\]]|$)/g;
const HEAVY = [
  "streamdown",
  "@streamdown/cjk",
  "@streamdown/code",
  "@streamdown/math",
  "@streamdown/mermaid",
  "shiki",
  "motion",
  "@xyflow/react",
  "media-chrome",
  "@rive-app/react-webgl2",
  "katex",
  "react-jsx-parser",
  "ansi-to-react",
  "tokenlens",
];

const specifiersOf = (source: string) => {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) found.add(m[1] as string);
  return [...found];
};

const kindOf = (specifier: string) => {
  if (specifier === "ai" || specifier.startsWith("@ai-sdk/")) return "aiSdk";
  if (specifier === "next" || specifier.startsWith("next/") || specifier === "next-themes") return "next";
  if (specifier.startsWith("@repo/shadcn-ui/components/ui/")) return "shadcnPrimitive";
  if (specifier === "@repo/shadcn-ui/lib/utils") return "cnHelper";
  if (specifier.startsWith("@radix-ui/") || specifier === "radix-ui") return "radix";
  if (specifier.startsWith(".")) return "local";
  if (specifier === "react" || specifier === "react-dom") return "react";
  return "thirdParty";
};

const examples = (matches: string[]) => [...new Set(matches)].slice(0, 6);

const files: Record<string, unknown> = {};
for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".tsx")).sort()) {
  const source = readFileSync(join(srcDir, name), "utf8");
  const specifiers = specifiersOf(source);
  const byKind: Record<string, string[]> = {};
  for (const s of specifiers) (byKind[kindOf(s)] ??= []).push(s.replace("@repo/shadcn-ui/components/ui/", ""));
  const palette = source.match(PALETTE) ?? [];
  const hex = source.match(HEX) ?? [];
  const functional = source.match(FUNCTIONAL) ?? [];
  const arbitrary = source.match(ARBITRARY) ?? [];
  const variants = source.match(ARBITRARY_VARIANT) ?? [];
  files[name.replace(".tsx", "")] = {
    lines: source.split("\n").length,
    useClient: /^["']use client["']/.test(source),
    aiSdk: byKind.aiSdk ?? [],
    aiSdkTypeNames: [...source.matchAll(/import type \{([^}]+)\} from "ai"/g)].flatMap((m) =>
      (m[1] as string).split(",").map((t) => t.trim()),
    ),
    aiValueImports: [...source.matchAll(/^import\s+(type\s+)?[^;]*?\s+from\s+"(?:ai|@ai-sdk\/[^"]+)";/gms)].filter((m) => !m[1]).length,
    useChat: /\buseChat\b/.test(source),
    cnCalls: (source.match(/\bcn\(/g) ?? []).length,
    next: byKind.next ?? [],
    shadcnPrimitives: byKind.shadcnPrimitive ?? [],
    radix: byKind.radix ?? [],
    thirdParty: byKind.thirdParty ?? [],
    heavy: (byKind.thirdParty ?? []).filter((s) => HEAVY.includes(s)),
    rawPaletteClasses: { count: palette.length, examples: examples(palette) },
    rawColourLiterals: { count: hex.length + functional.length, examples: examples([...hex, ...functional]) },
    shadcnSemanticColours: [...source.matchAll(SEMANTIC)].map((m) => m[1] as string),
    arbitraryValues: { count: arbitrary.length, examples: examples(arbitrary) },
    arbitraryVariants: { count: variants.length, examples: examples(variants) },
    aboveSafari164: Object.entries(ABOVE_FLOOR)
      .filter(([, re]) => re.test(source))
      .map(([label]) => label),
  };
}

type Row = {
  aiValueImports: number;
  cnCalls: number;
  aiSdk: string[];
  next: string[];
  useChat: boolean;
  rawPaletteClasses: { count: number };
  rawColourLiterals: { count: number };
  arbitraryValues: { count: number };
  arbitraryVariants: { count: number };
};
const rows = Object.values(files) as Row[];
const semanticCounts: Record<string, number> = {};
for (const row of Object.values(files) as { shadcnSemanticColours: string[] }[])
  for (const name of row.shadcnSemanticColours) semanticCounts[name] = (semanticCounts[name] ?? 0) + 1;
const summary = {
  shadcnSemanticColourNames: semanticCounts,
  components: rows.length,
  importingAiSdk: rows.filter((r) => r.aiSdk.length > 0).length,
  importingNext: rows.filter((r) => r.next.length > 0).length,
  aiValueImports: rows.reduce((sum, r) => sum + r.aiValueImports, 0),
  usingUseChat: rows.filter((r) => r.useChat).length,
  cnCallsTotal: rows.reduce((sum, r) => sum + r.cnCalls, 0),
  withRawPaletteClasses: rows.filter((r) => r.rawPaletteClasses.count > 0).length,
  withRawColourLiterals: rows.filter((r) => r.rawColourLiterals.count > 0).length,
  withArbitraryValues: rows.filter((r) => r.arbitraryValues.count > 0).length,
  withArbitraryVariants: rows.filter((r) => r.arbitraryVariants.count > 0).length,
};

const licences: Record<string, string> = {};
for (const [pkg, range] of Object.entries(manifest.dependencies)) {
  if (range.startsWith("workspace:")) continue;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`);
    const meta = (await res.json()) as { license?: string | { type?: string } };
    licences[pkg] = typeof meta.license === "string" ? meta.license : (meta.license?.type ?? "UNDECLARED");
  } catch (error) {
    licences[pkg] = `lookup failed: ${(error as Error).message}`;
  }
}

const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ commit, summary, dependencyLicences: licences, files }, null, 2));
