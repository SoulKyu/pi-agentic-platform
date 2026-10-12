import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classRule, compileStyles } from "./tailwind-compile.ts";

export interface Candidate {
  readonly className: string;
  readonly file: string;
  readonly line: number;
}

// Where class lists may live (plan convention): className, cn(...), and UPPER_CASE constants with these endings.
const CLASS_CONSTANT = /^(?:[A-Z][A-Z0-9_]*)?(?:CLASSES|VARIANTS|SIZES|TONES|STYLE|RING)$/;
// Markers that compile to nothing on purpose, and the plain classes tokens.css defines.
const NOT_UTILITIES = /^(?:group|peer)(?:\/[\w-]+)?$/;
const PLAIN_CLASSES = new Set(["theme-swap"]);
const SCANNED = /^(?:packages\/ui\/src|apps\/web\/src)\/.*\.tsx?$/;

export function classCandidates(file: string, text: string): Candidate[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Candidate[] = [];
  const add = (node: ts.Node, value: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const className of value.split(/\s+/).filter(Boolean)) out.push({ className, file, line });
  };
  // Strings that end up in a class list: branches and operands, never conditions or other calls' arguments.
  const strings = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    } else if (ts.isConditionalExpression(node)) {
      strings(node.whenTrue);
      strings(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      strings(node.right);
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) strings(node.left);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      strings(node.expression);
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(strings);
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties)
        if (ts.isPropertyAssignment(property)) strings(property.initializer);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cn")
      node.arguments.forEach(strings);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
      strings(
        ts.isJsxExpression(node.initializer) && node.initializer.expression
          ? node.initializer.expression
          : node.initializer,
      );
      return;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "cn"
    ) {
      node.arguments.forEach(strings);
      return;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      CLASS_CONSTANT.test(node.name.text) &&
      node.initializer
    ) {
      strings(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.filter((c) => !NOT_UTILITIES.test(c.className) && !PLAIN_CLASSES.has(c.className));
}

export function trackedSources(root: string): Array<{ file: string; text: string }> {
  // Tracked and new (untracked, not ignored) files: a task's own new files are checked before its commit.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        SCANNED.test(file) &&
        !file.includes(".test.") &&
        !file.includes("/testing/") &&
        existsSync(join(root, file)),
    )
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Classes used in the UI code that Tailwind and tokens.css do not generate (typos, stale names, dynamic fragments). */
export async function unknownClasses(
  root: string,
  files: ReadonlyArray<{ file: string; text: string }> = trackedSources(root),
): Promise<Candidate[]> {
  const candidates = files.flatMap(({ file, text }) => classCandidates(file, text));
  const build = await compileStyles();
  const css = build([...new Set(candidates.map((c) => c.className))]);
  return candidates.filter((c) => !classRule(c.className).test(css));
}
