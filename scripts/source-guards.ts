import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Guards that no comment can switch off. ESLint's own max-lines is a lint rule, and an inline config comment
// (block form, rule options) rewrites a rule before it runs without being a disable directive, so the lint
// comment guards never see it. This check reads the tracked files directly (ruling R64c).

export const MAX_LINES = 400;

export interface SourceViolation {
  readonly file: string;
  readonly rule: "max-lines" | "inline-config";
  readonly detail: string;
}

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs)$/u;
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|spikes|fixtures)\//u;
// What ESLint reads as configuration from a block comment (eslint-disable and eslint-enable are directives,
// held back by the eslint-comments rules).
const INLINE_CONFIG = /^(?:eslint|eslint-env|exported|globals?)(?:\s|$)/u;
const POSSIBLE_INLINE_CONFIG = /\/\*\s*(?:eslint|exported|globals?)/u;

const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/u;

export function lineCount(text: string): number {
  const lines = text.split(LINE_BREAK);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

interface BlockComment {
  readonly line: number;
  readonly text: string;
}

// Comments the parser sees, never string, template, regular expression or JSX text that only looks like one.
function blockComments(file: string, text: string): BlockComment[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map<number, BlockComment>();
  const collect = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        const line = source.getLineAndCharacterOfPosition(range.pos).line + 1;
        found.set(range.pos, { line, text: text.slice(range.pos + 2, range.end - 2) });
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      // The trivia in front of a token, read from where the previous token ended: the comments before the
      // first line break are "trailing" for the TypeScript API, the ones after it "leading".
      collect(ts.getTrailingCommentRanges(text, node.pos));
      collect(ts.getLeadingCommentRanges(text, node.pos));
    }
    children.forEach(visit);
  };
  visit(source);
  return [...found.values()];
}

export function checkSource(file: string, text: string): SourceViolation[] {
  const violations: SourceViolation[] = [];
  const lines = lineCount(text);
  if (lines > MAX_LINES) {
    violations.push({ file, rule: "max-lines", detail: `${lines} lines, the limit is ${MAX_LINES}` });
  }
  if (POSSIBLE_INLINE_CONFIG.test(text)) {
    for (const comment of blockComments(file, text)) {
      if (INLINE_CONFIG.test(comment.text.trim())) {
        violations.push({ file, rule: "inline-config", detail: `line ${comment.line}: /*${comment.text}*/` });
      }
    }
  }
  return violations;
}

export function trackedSourceFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((file) => SOURCE_FILE.test(file) && !SKIPPED_PATH.test(file) && existsSync(join(root, file)));
}

export function checkRepository(root: string): SourceViolation[] {
  return trackedSourceFiles(root).flatMap((file) =>
    checkSource(file, readFileSync(join(root, file), "utf8")),
  );
}
