import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const STYLES = join(REPO, "apps/web/src/styles.css");

/** Tailwind's selector escaping for a class name: every character outside [A-Za-z0-9_-] gets a backslash. */
export const escapeClass = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`);

/**
 * The web app's real stylesheet (Tailwind, @pap/ui tokens, utilities and fonts), compiled fresh: the returned
 * function builds the CSS for exactly the classes given. A fresh compiler per call keeps one test's classes out of
 * another's output.
 */
export async function compileStyles(): Promise<(candidates: readonly string[]) => string> {
  const compiler = await compile(readFileSync(STYLES, "utf8"), {
    base: dirname(STYLES),
    onDependency: () => {},
  });
  return (candidates) => compiler.build([...candidates]);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A rule whose selector starts with exactly this class (M3-RT-03): `.bg-surface` is not found inside `.bg-surface-2`,
 * `.w-` not inside `.w-full`, and `html[data-keyboard-open] .pb-safe` is not the `pb-safe` utility. A selector may
 * also start after `(` or `,` (`:where(.space-y-2 > …)`, selector lists).
 */
export const classRule = (className: string): RegExp =>
  new RegExp(`(?:^|[{};(,])\\s*\\.${escapeRegExp(escapeClass(className))}(?![\\w\\\\-])`);

/** The text from a class's selector to the end of its rule, or "" when the CSS has no rule for exactly that class. */
export function ruleOf(css: string, className: string): string {
  const match = classRule(className).exec(css);
  if (!match) return "";
  const at = match.index + match[0].indexOf(".");
  return css.slice(at, css.indexOf("}", at) + 1);
}
