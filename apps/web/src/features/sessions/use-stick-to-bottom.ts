import { useCallback, useLayoutEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 48;

export interface Measure {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The reader is at the end of the list, close enough that new rows should carry them along. */
export const stickDecision = (m: Measure): boolean =>
  m.scrollHeight - m.scrollTop - m.clientHeight < NEAR_BOTTOM_PX;

/** Where to scroll so the row the reader looked at stays put after rows of `newHeight - anchor.height` landed above it. */
export const scrollAfterPrepend = (anchor: { top: number; height: number }, newHeight: number): number =>
  anchor.top + (newHeight - anchor.height);

/**
 * Keeps a scrolling list at its end while it grows, unless the reader scrolled up to read: `change` is
 * anything that differs after the list grew. `preserveOnPrepend()` is called just before older rows are put
 * above the current ones: the next change then keeps the reader on the same row instead of following the end.
 * It returns a function that forgets the anchor, for when the rows never came.
 */
export function useStickToBottom(change: unknown) {
  const list = useRef<HTMLElement | null>(null);
  const pinned = useRef(true);
  const anchor = useRef<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (anchor.current) {
      element.scrollTop = scrollAfterPrepend(anchor.current, element.scrollHeight);
      anchor.current = null;
      pinned.current = stickDecision(element);
    } else if (pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [change]);
  const attach = useCallback((element: HTMLElement | null) => {
    list.current = element;
  }, []);
  const onScroll = useCallback(() => {
    if (list.current) pinned.current = stickDecision(list.current);
  }, []);
  const preserveOnPrepend = useCallback(() => {
    const element = list.current;
    const mine = element ? { top: element.scrollTop, height: element.scrollHeight } : null;
    anchor.current = mine;
    return () => {
      if (anchor.current === mine) anchor.current = null;
    };
  }, []);
  return { attach, onScroll, preserveOnPrepend } as const;
}
