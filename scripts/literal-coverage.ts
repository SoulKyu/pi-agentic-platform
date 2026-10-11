import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

// Attributes a person reads or hears (Orca's coverage audit list, plus our own label props).
const LABEL_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "placeholder",
  "alt",
  "label",
  "title",
  "stageLabel",
]);
const LETTER = /\p{L}/u;
// The gallery is dev-only and not shipped (ADR 0011) and shows sample content (data, not UI text); tests and test helpers are not shipped either.
const SCANNED = /^(?:packages\/ui\/src|apps\/web\/src)\/.*\.tsx$/;
// M2's folder waits for post-merge task P7, which deletes that alternative (M3-RT-24).
const SKIPPED = /\.test\.|\/testing\/|^apps\/web\/src\/gallery\/|^apps\/web\/src\/features\/sessions\//;

export function literalsIn(file: string, text: string): Literal[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Literal[] = [];
  const push = (node: ts.Node, value: string): void => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (LETTER.test(trimmed))
      out.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: trimmed,
      });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) push(node, node.text);
    else if (
      ts.isJsxAttribute(node) &&
      LABEL_ATTRIBUTES.has(node.name.getText(source)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    )
      push(node, node.initializer.text);
    else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      ts.isJsxElement(node.parent)
    )
      push(node, node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function checkLiterals(root: string): Literal[] {
  const allowed = JSON.parse(readFileSync(join(root, "scripts/literal-allowlist.json"), "utf8")) as Array<{
    file: string;
    text: string;
  }>;
  const isAllowed = (l: Literal) => allowed.some((a) => a.file === l.file && a.text === l.text);
  // Tracked and new (untracked, not ignored) files, so a task's own new screens are checked before its commit.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => SCANNED.test(file) && !SKIPPED.test(file) && existsSync(join(root, file)))
    .flatMap((file) => literalsIn(file, readFileSync(join(root, file), "utf8")))
    .filter((literal) => !isAllowed(literal));
}
