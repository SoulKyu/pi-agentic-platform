export type WhenNode =
  | { readonly type: "id"; readonly name: string }
  | { readonly type: "not"; readonly node: WhenNode }
  | { readonly type: "and" | "or"; readonly left: WhenNode; readonly right: WhenNode };
export type WhenError = {
  readonly error: "empty" | "unexpected" | "unclosed" | "too_deep";
  readonly at: number;
};

const MAX_DEPTH = 64;
/** The contract caps a stored clause at 256 characters; the parser refuses longer text on its own. */
const MAX_LENGTH = 256;
const TOKEN = /\s*(\(|\)|!|&&|\|\||[A-Za-z_][A-Za-z0-9_.-]*)/y;

/**
 * T3's grammar: identifiers, !, &&, ||, parentheses; ! binds tighter than &&, && tighter than ||. Never evaluates text:
 * the result is a tree walked by `evaluateWhen`, and anything malformed (or not a string) is an error value.
 */
export function parseWhen(text: string): WhenNode | WhenError {
  if (typeof text !== "string" || text.trim() === "") return { error: "empty", at: 0 };
  if (text.length > MAX_LENGTH) return { error: "unexpected", at: MAX_LENGTH };
  const tokens: Array<{ value: string; at: number }> = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(start).trim() === "") break;
      return {
        error: "unexpected",
        at: start + (text.length - start - text.slice(start).trimStart().length),
      };
    }
    const value = match[1] ?? "";
    tokens.push({ value, at: TOKEN.lastIndex - value.length });
  }
  let i = 0;
  const fail = (error: WhenError["error"]): never => {
    throw { error, at: tokens[i]?.at ?? text.length } satisfies WhenError;
  };
  const unary = (depth: number): WhenNode => {
    if (depth > MAX_DEPTH) fail("too_deep");
    const token = tokens[i];
    if (!token) return fail("unexpected");
    if (token.value === "!") {
      i++;
      return { type: "not", node: unary(depth + 1) };
    }
    if (token.value === "(") {
      i++;
      const inner = or(depth + 1);
      if (tokens[i]?.value !== ")") fail("unclosed");
      i++;
      return inner;
    }
    if (/^[A-Za-z_]/.test(token.value)) {
      i++;
      return { type: "id", name: token.value };
    }
    return fail("unexpected");
  };
  const and = (depth: number): WhenNode => {
    let left = unary(depth);
    while (tokens[i]?.value === "&&") {
      i++;
      left = { type: "and", left, right: unary(depth) };
    }
    return left;
  };
  const or = (depth: number): WhenNode => {
    let left = and(depth);
    while (tokens[i]?.value === "||") {
      i++;
      left = { type: "or", left, right: and(depth) };
    }
    return left;
  };
  try {
    const node = or(0);
    if (i < tokens.length) fail("unexpected");
    return node;
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) return error as WhenError;
    throw error;
  }
}

export function evaluateWhen(node: WhenNode, context: Readonly<Record<string, boolean>>): boolean {
  switch (node.type) {
    case "id":
      return node.name === "true"
        ? true
        : node.name === "false"
          ? false
          : Object.hasOwn(context, node.name) && context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

export function mentions(node: WhenNode, name: string): boolean {
  if (node.type === "id") return node.name === name;
  if (node.type === "not") return mentions(node.node, name);
  return mentions(node.left, name) || mentions(node.right, name);
}
