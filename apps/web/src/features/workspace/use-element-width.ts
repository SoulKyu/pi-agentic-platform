import { useLayoutEffect, useState, type RefObject } from "react";

/** The element's content width in px; 0 before the first measure. The observer is disconnected on unmount. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const last = entries.at(-1);
      if (last) setWidth(last.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
