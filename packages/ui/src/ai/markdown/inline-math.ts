/** A node of the markdown tree, read structurally (no direct dependency on mdast's types). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: { hName?: string; hChildren?: unknown; hProperties?: { className?: unknown } };
}

/** `$ x$`, `$x $`: a space just inside a single `$`. And `$x$5`: a digit right after the closing `$`. */
function readsAsPrice(source: string, next: string): boolean {
  if (source.startsWith("$$")) return false;
  return /^\s|\s$/u.test(source.slice(1, -1)) || /^\d/u.test(next);
}

/**
 * remark-math reads `$5 and $10` as a formula. This step turns an inline math node back into text when its source
 * (by position, read from the file) breaks pandoc's rule for a single `$`: a space just inside it, or a digit right
 * after the closing one. `$$x$$` written inline is display math.
 */
export function pandocDollars(): (tree: MdNode, file: { readonly value: unknown }) => void {
  return (tree, file) => {
    const text = typeof file.value === "string" ? file.value : String(file.value);
    const walk = (node: MdNode) => {
      const children = node.children;
      if (!children) return;
      for (const [index, child] of children.entries()) {
        if (child.type === "inlineMath") {
          const start = child.position?.start?.offset;
          const end = child.position?.end?.offset;
          const source = start === undefined || end === undefined ? undefined : text.slice(start, end);
          if (source !== undefined && source.startsWith("$")) {
            if (readsAsPrice(source, text.charAt(end ?? 0))) {
              children[index] = { type: "text", value: source };
            } else if (source.startsWith("$$")) {
              const data = child.data ?? {};
              const classes = data.hProperties?.className;
              child.data = {
                ...data,
                hProperties: {
                  ...data.hProperties,
                  className: [...(Array.isArray(classes) ? classes : []), "math-display"],
                },
              };
            }
          }
        } else {
          walk(child);
        }
      }
      mergeText(children);
    };
    walk(tree);
  };
}

/** Neighbouring text nodes become one, so a path or a price is read whole. */
function mergeText(children: MdNode[]): void {
  for (let index = children.length - 1; index > 0; index -= 1) {
    const here = children[index];
    const before = children[index - 1];
    if (here?.type === "text" && before?.type === "text") {
      before.value = (before.value ?? "") + (here.value ?? "");
      children.splice(index, 1);
    }
  }
}
