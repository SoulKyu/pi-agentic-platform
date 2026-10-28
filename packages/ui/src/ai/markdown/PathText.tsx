import { Children, createContext, useContext, type ReactNode } from "react";
import { cn } from "../../cn.ts";
import type { PathLinks } from "./reply-tools.ts";

const PathLinksContext = createContext<PathLinks | undefined>(undefined);

/** The reply tools of one rendered message; wraps the markdown body from outside. */
export function ReplyTools({
  pathLinks,
  children,
}: {
  readonly pathLinks?: PathLinks;
  readonly children: ReactNode;
}) {
  return <PathLinksContext.Provider value={pathLinks}>{children}</PathLinksContext.Provider>;
}

const PATH_CLASSES = cn(
  "inline cursor-pointer text-left text-agent focus-ring",
  "can-hover:hover:underline focus-visible:underline",
);

function LinkedText({
  text,
  links,
  whole,
}: {
  readonly text: string;
  readonly links: PathLinks;
  readonly whole: boolean;
}) {
  const spans = links.find(text, whole);
  if (spans.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) parts.push(text.slice(at, span.start));
    parts.push(
      <button
        key={span.start}
        type="button"
        data-path-link=""
        aria-label={links.label(span)}
        className={PATH_CLASSES}
        onClick={() => links.open(span)}
      >
        {span.text}
      </button>,
    );
    at = span.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The string children of a block or an inline wrapper, with the paths in them as buttons. Other children (emphasis,
 * links, code) pass through untouched; without `pathLinks` the children are returned as they came.
 */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function PathText({ children, whole }: { readonly children?: ReactNode; readonly whole?: boolean }) {
  const links = useContext(PathLinksContext);
  if (links === undefined) return <>{children}</>;
  return (
    <>
      {Children.map(children, (child) =>
        typeof child === "string" ? <LinkedText text={child} links={links} whole={whole ?? false} /> : child,
      )}
    </>
  );
}
