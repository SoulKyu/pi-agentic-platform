import { useEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 48;

/**
 * Keeps a scrolling list at its end while it grows, unless the reader scrolled up to read: `change` is
 * anything that differs after the list grew. Returns the list's `ref` callback and its scroll handler.
 */
export function useStickToBottom(change: unknown) {
  const list = useRef<HTMLElement | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (list.current && pinned.current) list.current.scrollTop = list.current.scrollHeight;
  }, [change]);
  const attach = (element: HTMLElement | null) => {
    list.current = element;
  };
  const onScroll = () => {
    const element = list.current;
    if (element)
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
  };
  return [attach, onScroll] as const;
}
