import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;
const FOLDERS = [
  "features/appearance",
  "features/models",
  "features/mcp",
  "features/skills",
  "features/usage",
  "features/notifications",
  "features/health",
  "features/auth",
  "features/users",
  "features/settings",
  "features/github",
  "routes/settings",
];
const HEADING_START = /<(?:h[234]|Heading)\b/g;

/** The opening tag from `start` to its closing `>`, skipping braces and quotes so a multi-line tag is whole. */
function openingTag(text: string, start: number): string {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quote) {
      if (char === quote) quote = "";
    } else if (depth > 0 && (char === '"' || char === "'" || char === "`")) quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === '"' && depth === 0) quote = char;
    else if (char === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const MONO_LABEL = /\blabel-hud\b|\btext-label\b/;

/** The headings of `text` that wear the mono label: in their className, or through a string constant it names. */
function monoLabelHeadings(text: string): string[] {
  return [...text.matchAll(HEADING_START)]
    .map((match) => openingTag(text, match.index))
    .filter((tag) => {
      if (MONO_LABEL.test(tag)) return true;
      const name = /className=\{(\w+)\}/.exec(tag)?.[1];
      if (name === undefined) return false;
      const bound = new RegExp(`\\bconst ${name}\\s*=\\s*(["'\`])([^"'\`]*)\\1`).exec(text);
      return bound !== null && MONO_LABEL.test(bound[2] as string);
    })
    .map((tag) => tag.replace(/\s+/g, " "));
}

function labelHudHeadings(file: string): string[] {
  return monoLabelHeadings(readFileSync(file, "utf8")).map((tag) => `${file.slice(SRC.length + 1)}: ${tag}`);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe("the heading scanner", () => {
  it("reads a multi-line tag to its closing bracket", () => {
    expect(monoLabelHeadings('<h3\n  id={`x-${y}`}\n  className="flex label-hud"\n>')).toHaveLength(1);
  });

  it('flags <Heading className="label-hud"> and not <Heading variant="card">', () => {
    expect(monoLabelHeadings('<Heading level={3} className="label-hud">')).toHaveLength(1);
    expect(monoLabelHeadings('<Heading level={3} variant="card">')).toEqual([]);
  });

  it("flags a className bound to a label-hud constant, and text-label", () => {
    expect(monoLabelHeadings('const label = "label-hud text-muted";\n<h4 className={label}>')).toHaveLength(
      1,
    );
    expect(monoLabelHeadings('const label = "text-fg";\n<h4 className={label}>')).toEqual([]);
    expect(monoLabelHeadings('<h3 className="text-label text-muted">')).toHaveLength(1);
  });
});

describe("Settings headings", () => {
  it("no h2, h3 or h4 in the Settings folders carries the mono label (label-hud or text-label)", () => {
    const found = FOLDERS.flatMap((folder) => sources(join(SRC, folder))).flatMap(labelHudHeadings);
    expect(found).toEqual([]);
  });

  it("no h2, h3 or h4 in apps/web carries the mono label (label-hud or text-label)", () => {
    expect(sources(SRC).flatMap(labelHudHeadings)).toEqual([]);
  });

  it("no Settings panel stacks its sections with gap-s6", () => {
    const found = FOLDERS.flatMap((folder) => sources(join(SRC, folder))).filter((file) =>
      /\bgap-s6\b/.test(readFileSync(file, "utf8")),
    );
    expect(found.map((file) => file.slice(SRC.length + 1))).toEqual([]);
  });
});
