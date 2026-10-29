/** A reply resolves this many images; the rest stay `[image: alt]` (one HEAD request each, same origin). */
export const MAX_IMAGES = 32;
export const OVER_CAP = "data-over-cap";

/** A node of the markdown tree, read structurally (no direct dependency on mdast's types). */
interface MdNode {
  type: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** Marks every image after the 32nd, in reading order, so the renderer never looks it up. */
export function capImages(): (tree: MdNode) => void {
  return (tree) => {
    let seen = 0;
    const walk = (node: MdNode) => {
      if (node.type === "image" || node.type === "imageReference") {
        seen += 1;
        if (seen > MAX_IMAGES) {
          const data = node.data ?? {};
          node.data = { ...data, hProperties: { ...data.hProperties, [OVER_CAP]: "true" } };
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
