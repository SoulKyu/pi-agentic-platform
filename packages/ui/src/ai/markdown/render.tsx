import { Children, createContext, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "../../cn.ts";
import { BoxImage } from "./BoxImage.tsx";
import { CodeBlock, type CodeCopyLabels } from "./CodeBlock.tsx";
import { HtmlFence } from "./HtmlFence.tsx";
import { capImages, OVER_CAP } from "./image-cap.ts";
import { pandocDollars } from "./inline-math.ts";
import { MathBlock } from "./MathBlock.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { PathText, ReplyTools } from "./PathText.tsx";
import { SHELL_LANGS, type PathLinks, type ShellHandOff } from "./reply-tools.ts";
import { RichRepliesContext, type RichReplies } from "./rich-replies.ts";
import { safeHref } from "./safe-url.ts";
import { ShellBlock, ShellHandOffContext } from "./ShellBlock.tsx";

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
  readonly position?: { readonly start?: { readonly offset?: number } };
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
  const labels = useContext(CopyLabels);
  const handOff = useContext(ShellHandOffContext);
  if (lang.toLowerCase() === "math") return <MathBlock tex={code} display />;
  if (lang.toLowerCase() === "mermaid") return <MermaidBlock code={code} labels={labels} />;
  if (lang.toLowerCase() === "html") {
    return (
      <HtmlFence code={code} lang={lang} labels={labels} offset={node?.position?.start?.offset ?? null} />
    );
  }
  if (handOff && SHELL_LANGS.has(lang.toLowerCase())) {
    return <ShellBlock code={code} lang={lang} labels={labels} handOff={handOff} />;
  }
  return <CodeBlock code={code} lang={lang} labels={labels} />;
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = href ? safeHref(href) : null;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
        <ReplyTools>{children}</ReplyTools>
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // An image is never a request to wherever the model pointed (zero telemetry, CSP img-src): the app resolves a file of
  // the session's roots, and anything else shows as `[image: alt]`.
  img: (props) => (
    <BoxImage
      src={typeof props.src === "string" ? props.src : ""}
      alt={props.alt ?? ""}
      skip={(props as Record<string, unknown>)[OVER_CAP] === "true"}
    />
  ),
  pre: ({ node }) => <FencedCode node={node as HastNode | undefined} />,
  p: ({ children }) => (
    <p className="max-w-measure text-pretty">
      <PathText>{children}</PathText>
    </p>
  ),
  li: ({ children }) => (
    <li className="text-pretty">
      <PathText>{children}</PathText>
    </li>
  ),
  code: ({ children, className }) => {
    // remark-math's inline formula: `language-math math-inline` (and `math-display` for `$$x$$` written inline).
    const classes = (className ?? "").split(" ");
    if (classes.includes("math-inline")) {
      return (
        <MathBlock tex={Children.toArray(children).join("")} display={classes.includes("math-display")} />
      );
    }
    return (
      <code className={INLINE_CODE_CLASSES}>
        <PathText whole>{children}</PathText>
      </code>
    );
  },
  strong: ({ children }) => (
    <strong>
      <PathText>{children}</PathText>
    </strong>
  ),
  em: ({ children }) => (
    <em>
      <PathText>{children}</PathText>
    </em>
  ),
  del: ({ children }) => (
    <del>
      <PathText>{children}</PathText>
    </del>
  ),
  ul: ({ children }) => <ul className={cn(LIST_CLASSES, "list-disc")}>{children}</ul>,
  ol: ({ children }) => <ol className={cn(LIST_CLASSES, "list-decimal")}>{children}</ol>,
  blockquote: ({ children }) => <blockquote className={QUOTE_CLASSES}>{children}</blockquote>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASSES}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className={cn(CELL_CLASSES, "font-semibold")}>
      <PathText>{children}</PathText>
    </th>
  ),
  td: ({ children }) => (
    <td className={CELL_CLASSES}>
      <PathText>{children}</PathText>
    </td>
  ),
  h1: ({ children }) => (
    <p className="max-w-measure font-bold">
      <PathText>{children}</PathText>
    </p>
  ),
  h2: ({ children }) => (
    <p className="max-w-measure font-bold">
      <PathText>{children}</PathText>
    </p>
  ),
  h3: ({ children }) => (
    <p className="max-w-measure font-semibold">
      <PathText>{children}</PathText>
    </p>
  ),
  h4: ({ children }) => (
    <p className="max-w-measure font-semibold">
      <PathText>{children}</PathText>
    </p>
  ),
  h5: ({ children }) => (
    <p className="max-w-measure font-semibold">
      <PathText>{children}</PathText>
    </p>
  ),
  h6: ({ children }) => (
    <p className="max-w-measure font-semibold">
      <PathText>{children}</PathText>
    </p>
  ),
};

/** pi-web's pipeline (react-markdown + remark-gfm, plus remark-math) without raw HTML; lazy-loaded by Markdown.tsx. The reply tools wrap it from outside. */
export default function MarkdownBody({
  text,
  copyLabels,
  pathLinks,
  shellHandOff,
  richReplies,
}: {
  readonly text: string;
  readonly copyLabels?: CodeCopyLabels;
  readonly pathLinks?: PathLinks;
  readonly shellHandOff?: ShellHandOff;
  readonly richReplies?: RichReplies;
}) {
  return (
    <ReplyTools pathLinks={pathLinks}>
      <ShellHandOffContext.Provider value={shellHandOff}>
        <RichRepliesContext.Provider value={richReplies}>
          <MarkdownTree text={text} copyLabels={copyLabels} />
        </RichRepliesContext.Provider>
      </ShellHandOffContext.Provider>
    </ReplyTools>
  );
}

function MarkdownTree({ text, copyLabels }: { readonly text: string; readonly copyLabels?: CodeCopyLabels }) {
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
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, pandocDollars, capImages, htmlAsText]}
          skipHtml
          components={COMPONENTS}
        >
          {text}
        </ReactMarkdown>
      </CopyLabels.Provider>
    </div>
  );
}
