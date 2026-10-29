import { useContext, useEffect, useState } from "react";
import { cn } from "../../cn.ts";
import { RichRepliesContext } from "./rich-replies.ts";

/** TeX longer than this stays source: KaTeX is not asked to lay out a wall of text. */
export const MAX_TEX_CHARS = 10_000;

const DISPLAY_CLASSES = "contain-rich block max-w-full";
/** A wide formula scrolls inside its box instead of being cut off. */
const SCROLL_CLASSES = "block overflow-x-auto overflow-y-hidden";
const INLINE_CLASSES = "contain-rich-inline";
const SOURCE_CLASSES = "whitespace-pre-wrap break-words font-mono text-code";

// Outside the component: the React Compiler does not lower an `import()` expression.
const loadMath = () => import("./math.ts");

interface Done {
  readonly tex: string;
  readonly display: boolean;
  readonly html: string | null;
}

/**
 * One formula. KaTeX's own escaped markup goes in with `dangerouslySetInnerHTML` (the app CSP blocks any script
 * regardless), inside a box that is paint-contained (UX2-R81, decision 139): `contain-rich` for display math,
 * `contain-rich-inline` for inline. The TeX shows as source while KaTeX loads, when it is too long, and if it fails.
 * Always a `span`: a formula sits inside paragraphs.
 */
export function MathBlock({ tex, display }: { readonly tex: string; readonly display: boolean }) {
  const [done, setDone] = useState<Done | null>(null);
  const reportFailure = useContext(RichRepliesContext)?.onLoadError;
  const tooLong = tex.length > MAX_TEX_CHARS;
  useEffect(() => {
    if (tooLong) return;
    let live = true;
    loadMath()
      .then(({ renderTex }) => {
        if (live) setDone({ tex, display, html: renderTex(tex, display) });
      })
      .catch(() => {
        if (!live) return;
        setDone({ tex, display, html: null });
        reportFailure?.();
      });
    return () => {
      live = false;
    };
  }, [tex, display, tooLong, reportFailure]);
  const html = !tooLong && done?.tex === tex && done.display === display ? done.html : null;
  const box = display ? DISPLAY_CLASSES : INLINE_CLASSES;
  if (html === null) {
    return (
      <span data-math={display ? "display" : "inline"} className={cn(box, SOURCE_CLASSES)}>
        {tex}
      </span>
    );
  }
  if (display) {
    return (
      <span data-math="display" className={box}>
        <span className={SCROLL_CLASSES} dangerouslySetInnerHTML={{ __html: html }} />
      </span>
    );
  }
  return <span data-math="inline" className={box} dangerouslySetInnerHTML={{ __html: html }} />;
}
