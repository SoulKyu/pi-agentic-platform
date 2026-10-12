import { useSyncExternalStore } from "react";

/** A media query as React state (T3 hooks/useMediaQuery.ts). False where matchMedia does not exist. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** DESIGN.md §8: below 768 px is a phone. */
export const PHONE_QUERY = "(max-width: 767.98px)";
export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY);
