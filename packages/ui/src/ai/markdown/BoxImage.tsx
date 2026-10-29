import { useContext, useEffect, useState } from "react";
import { RichRepliesContext, type ImageResult } from "./rich-replies.ts";

const LINK_CLASSES =
  "inline cursor-pointer text-left text-agent focus-ring can-hover:hover:underline focus-visible:underline";

type Looked = { readonly src: string; readonly result: ImageResult } | null;

/**
 * A reply's `![alt](src)`. The app judges the source (a file of the session's own roots, a HEAD check on the same-origin
 * raw route); this component only ever renders what that answer allows: an `<img>`, a button that opens the file, or the
 * alt text. Never an iframe, an object or an embed, and never a URL the model wrote. `skip`: past the reply's cap, no
 * lookup. An empty alt shows the source in its place, so what is read is what is named.
 */
export function BoxImage({
  src,
  alt,
  skip,
}: {
  readonly src: string;
  readonly alt: string;
  readonly skip?: boolean;
}) {
  const rich = useContext(RichRepliesContext);
  const lookup = skip === true ? undefined : rich?.image;
  const [looked, setLooked] = useState<Looked>(null);
  useEffect(() => {
    if (lookup === undefined) return;
    let live = true;
    const stop = new AbortController();
    lookup(src, stop.signal).then(
      (result) => {
        if (live) setLooked({ src, result });
      },
      () => {
        if (live) setLooked({ src, result: { kind: "text" } });
      },
    );
    return () => {
      live = false;
      stop.abort();
    };
  }, [lookup, src]);
  const shown = alt === "" ? src : alt;
  const text = rich ? rich.labels.image(shown) : `[image: ${shown}]`;
  if (lookup === undefined) return <span>{text}</span>;
  if (looked?.src !== src) return <span>{shown}</span>;
  const result = looked.result;
  if (result.kind === "image") {
    return (
      <img
        src={result.url}
        alt={shown}
        loading="lazy"
        referrerPolicy="no-referrer"
        decoding="async"
        className="inline-block h-auto max-w-measure rounded-sm"
      />
    );
  }
  if (result.kind === "file" && rich?.openFile !== undefined) {
    const open = rich.openFile;
    const path = result.path;
    return (
      <button
        type="button"
        aria-description={rich.labels.openFile(path)}
        className={LINK_CLASSES}
        onClick={() => open(path)}
      >
        {alt === "" ? path : alt}
      </button>
    );
  }
  return <span>{text}</span>;
}
