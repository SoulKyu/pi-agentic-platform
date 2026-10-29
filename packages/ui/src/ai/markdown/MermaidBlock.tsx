import { useContext, useEffect, useId, useRef, useState } from "react";
import { InlineError } from "../../primitives/InlineError.tsx";
import { CodeBlock, type CodeCopyLabels } from "./CodeBlock.tsx";
import { MAX_DIAGRAM_CHARS } from "./diagram-size.ts";
import { RichRepliesContext } from "./rich-replies.ts";

/** A reply streams a delta every few milliseconds: a diagram is drawn only once its source has been quiet this long. */
const QUIET_MS = 400;

type Drawn = { readonly code: string; readonly src: string | null };

// Outside the component: the React Compiler does not lower an `import()` expression. Mermaid loads with the first diagram.
const loadMermaid = () => import("./mermaid.ts");

/** The SVG text as a `data:` URL. Opaque, unlike a `blob:` URL (same-origin: "open image in a new tab" would show a pap-origin SVG document with forms). */
function dataUrlOf(svg: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(svg)) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * A `mermaid` fence (UX2-R48, R83, decision 139). The source shows until it has been quiet 400 ms; Mermaid then draws it
 * into a hidden container of this block's own, and what pap shows is `<img src="data:image/svg+xml;base64,…">` of the SVG
 * text: an image runs no script, applies no CSS to pap, submits no form and follows no link, whatever the model wrote in
 * the diagram, and a `data:` URL is opaque (a `blob:` one is same-origin). The block is paint-contained (`contain-rich`).
 * Mermaid's own text measurer briefly appends an `<svg>` to `document.body` while it lays a diagram out; it removes it
 * synchronously, or leaves it when a measurement throws (an empty bounding box), so containment covers the container and
 * not that probe. A syntax error keeps the source and says so; a source over 20 000 characters is never drawn; a chunk
 * that fails to load is reported like KaTeX's. No markup is ever written into the page.
 */
export function MermaidBlock({ code, labels }: { readonly code: string; readonly labels?: CodeCopyLabels }) {
  const rich = useContext(RichRepliesContext);
  const reportFailure = rich?.onLoadError;
  const host = useRef<HTMLDivElement>(null);
  const draws = useRef(0);
  const base = `pap-diagram-${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const tooLarge = code.length > MAX_DIAGRAM_CHARS;
  useEffect(() => {
    if (tooLarge) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const container = host.current;
      if (container === null) return;
      loadMermaid()
        .then(
          ({ drawDiagram }) =>
            drawDiagram(`${base}-${++draws.current}`, code, container).then(
              (svg) => {
                if (live) setDrawn({ code, src: dataUrlOf(svg) });
              },
              () => {
                if (live) setDrawn({ code, src: null });
              },
            ),
          () => {
            if (!live) return;
            setDrawn({ code, src: null });
            reportFailure?.();
          },
        )
        .finally(() => {
          // Mermaid leaves its transient SVG (or its error drawing) in the container; a draw that was replaced leaves it to the next.
          if (live) container.replaceChildren();
        });
    }, QUIET_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [code, tooLarge, base, reportFailure]);
  const current = !tooLarge && drawn?.code === code ? drawn : null;
  const failure = tooLarge
    ? rich?.labels.mermaidTooLarge
    : current?.src === null
      ? rich?.labels.mermaidError
      : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-s1">
      <div data-diagram="" className="contain-rich relative max-w-full">
        <div ref={host} aria-hidden="true" className="invisible absolute inset-0 overflow-hidden" />
        {current?.src ? (
          <img
            src={current.src}
            alt={rich?.labels.diagram ?? ""}
            decoding="async"
            className="mx-auto block h-auto max-w-full"
          />
        ) : null}
      </div>
      {current?.src ? (
        <details>
          <summary className="cursor-pointer label-hud text-muted focus-ring">mermaid</summary>
          <CodeBlock code={code} lang="mermaid" labels={labels} />
        </details>
      ) : (
        <CodeBlock code={code} lang="mermaid" labels={labels} />
      )}
      {failure ? <InlineError announce="background">{failure}</InlineError> : null}
    </div>
  );
}
