/**
 * Static check of the built bundles against the Safari 16.4 floor (spec C 7.3): runtime APIs newer than 16.4 that the JS mentions.
 * A hit is a lead, not a verdict: the call may be feature-detected. `safari` is the first Safari version that has the API.
 * Vite's `build.target` lowers syntax only; it never polyfills these.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const apis: ReadonlyArray<{ name: string; safari: string; pattern: RegExp }> = [
  { name: "Object.groupBy / Map.groupBy", safari: "17.4", pattern: /\b(?:Object|Map)\.groupBy\b/g },
  { name: "Promise.withResolvers", safari: "17.4", pattern: /Promise\.withResolvers/g },
  { name: "AbortSignal.any", safari: "17.4", pattern: /AbortSignal\.any\b/g },
  { name: "Element.checkVisibility", safari: "17.4", pattern: /\.checkVisibility\(/g },
  { name: "setHTMLUnsafe / parseHTMLUnsafe", safari: "17.4", pattern: /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/g },
  { name: "Set methods (union, intersection, ...)", safari: "17.0", pattern: /\.(?:symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/g },
  { name: "RegExp v flag (unicodeSets)", safari: "17.0", pattern: /unicodeSets|new RegExp\([^)]{0,200},\s*["'`][a-z]*v[a-z]*["'`]\)/g },
  { name: "Iterator helpers (Iterator.from, ...)", safari: "18.4", pattern: /\bIterator\.(?:from|prototype)\b/g },
  { name: "Promise.try", safari: "18.2", pattern: /Promise\.try\b/g },
  { name: "RegExp.escape", safari: "18.2", pattern: /RegExp\.escape\b/g },
  { name: "Float16Array", safari: "18.2", pattern: /Float16Array/g },
  { name: "import attributes (with { type })", safari: "17.2", pattern: /\bwith\s*\{\s*type\s*:/g },
  { name: "requestIdleCallback (absent in Safari)", safari: "never", pattern: /requestIdleCallback/g },
  { name: "scheduler.postTask / yield (absent in Safari)", safari: "never", pattern: /scheduler\.(?:postTask|yield)\b/g },
];

const hits = (dir: string) => {
  const files = readdirSync(join(dir, "assets")).filter((file) => file.endsWith(".js"));
  const found: Record<string, { safari: string; files: number; matches: number }> = {};
  for (const file of files) {
    const text = readFileSync(join(dir, "assets", file), "utf8");
    for (const { name, safari, pattern } of apis) {
      const count = text.match(pattern)?.length ?? 0;
      if (count === 0) continue;
      const entry = (found[name] ??= { safari, files: 0, matches: 0 });
      entry.files += 1;
      entry.matches += count;
    }
  }
  return { jsFiles: files.length, found };
};

console.log(JSON.stringify(Object.fromEntries(["codemirror-syntax", "pierre", "pierre-worker"].map((mode) => [mode, hits(`dist-${mode}`)])), null, 2));
