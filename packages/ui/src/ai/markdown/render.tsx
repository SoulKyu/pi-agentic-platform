import { createContext, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../cn.ts";
import { CodeBlock, type CodeCopyLabels } from "./CodeBlock.tsx";
import { safeHref } from "./safe-url.ts";

export const MAX_MARKDOWN_CHARS = 100_000;

const BODY_CLASSES = "flex min-w-0 flex-col gap-s2 whitespace-normal break-words text-chat";
const PLAIN_CLASSES = "max-w-measure whitespace-pre-wrap break-words text-chat";
const LINK_CLASSES = "text-agent underline underline-offset-2 focus-ring";
const INLINE_CODE_CLASSES = "rounded-sm bg-surface-2 px-s1 font-mono text-code";
const LIST_CLASSES = "flex max-w-measure flex-col gap-s1 pl-s4";
const TABLE_CLASSES = "w-full border-collapse text-ui";
const CELL_CLASSES = "border border-border px-s2 py-s1 text-left align-top";
const QUOTE_CLASSES = "max-w-measure border-l-2 border-border pl-s3 text-muted";

/** A node of the markdown tree, read structurally (no direct dependency on mdast's types). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/**
 * Raw HTML in model text is text: `Array<string>` and `<img ...>` show as typed. An `html` node becomes a `text` node
 * (a paragraph holding one, where a block is expected); nothing is ever parsed as HTML, and nothing is dropped.
 */
function htmlAsText(): (tree: MdNode) => void {
  const walk = (node: MdNode) => {
    const children = node.children;
    if (!children) return;
    for (const [index, child] of children.entries()) {
      if (child.type === "html") {
        const text: MdNode = { type: "text", value: child.value ?? "" };
        children[index] = BLOCK_PARENTS.has(node.type) ? { type: "paragraph", children: [text] } : text;
      } else {
        walk(child);
      }
    }
  };
  return walk;
}

/** The hast node react-markdown hands to a component, read structurally (no direct dependency on hast's types). */
interface HastNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: readonly HastNode[];
}

const textOf = (node: HastNode | undefined): string =>
  (node?.value ?? "") + (node?.children ?? []).map(textOf).join("");

function fenced(node: HastNode | undefined): { code: string; lang: string } {
  const code = node?.children?.find((child) => child.tagName === "code");
  const classes = code?.properties?.className;
  const lang =
    (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((name) => name.startsWith("language-"))
      ?.slice(9) ?? "";
  return { code: textOf(code).replace(/\n$/, ""), lang };
}

const CopyLabels = createContext<CodeCopyLabels | undefined>(undefined);

function FencedCode({ node }: { readonly node: HastNode | undefined }) {
  const { code, lang } = fenced(node);
  return <CodeBlock code={code} lang={lang} labels={useContext(CopyLabels)} />;
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = href ? safeHref(href) : null;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // An image would be a request to wherever the model pointed (zero telemetry, CSP img-src): show its alt text.
  img: ({ alt }) => <span>{alt ?? ""}</span>,
  pre: ({ node }) => <FencedCode node={node as HastNode | undefined} />,
  p: ({ children }) => <p className="max-w-measure text-pretty">{children}</p>,
  li: ({ children }) => <li className="text-pretty">{children}</li>,
  code: ({ children }) => <code className={INLINE_CODE_CLASSES}>{children}</code>,
  ul: ({ children }) => <ul className={cn(LIST_CLASSES, "list-disc")}>{children}</ul>,
  ol: ({ children }) => <ol className={cn(LIST_CLASSES, "list-decimal")}>{children}</ol>,
  blockquote: ({ children }) => <blockquote className={QUOTE_CLASSES}>{children}</blockquote>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASSES}>{children}</table>
    </div>
  ),
  th: ({ children }) => <th className={cn(CELL_CLASSES, "font-semibold")}>{children}</th>,
  td: ({ children }) => <td className={CELL_CLASSES}>{children}</td>,
  h1: ({ children }) => <p className="max-w-measure font-bold">{children}</p>,
  h2: ({ children }) => <p className="max-w-measure font-bold">{children}</p>,
  h3: ({ children }) => <p className="max-w-measure font-semibold">{children}</p>,
  h4: ({ children }) => <p className="max-w-measure font-semibold">{children}</p>,
  h5: ({ children }) => <p className="max-w-measure font-semibold">{children}</p>,
  h6: ({ children }) => <p className="max-w-measure font-semibold">{children}</p>,
};

/** pi-web's pipeline (react-markdown + remark-gfm) without raw HTML; lazy-loaded by Markdown.tsx. */
export default function MarkdownBody({
  text,
  copyLabels,
}: {
  readonly text: string;
  readonly copyLabels?: CodeCopyLabels;
}) {
  if (text.length > MAX_MARKDOWN_CHARS) {
    return (
      <div data-markdown-plain="" className={PLAIN_CLASSES}>
        {text}
      </div>
    );
  }
  return (
    <div data-markdown-body="" className={BODY_CLASSES}>
      <CopyLabels.Provider value={copyLabels}>
        <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText]} skipHtml components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </CopyLabels.Provider>
    </div>
  );
}
