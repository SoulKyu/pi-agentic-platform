import { useEffect } from "react";

interface ViewportHeightState {
  readonly hasFocusedEditable: boolean;
  readonly innerHeight: number;
  readonly viewportHeight: number;
  readonly viewportScale: number;
}

/** Smallest visual-viewport shrink that only an on-screen keyboard causes; a Safari toolbar stays below it. */
export const KEYBOARD_MIN_HEIGHT_PX = 60;

/** Page zoom shrinks the visual viewport to `innerHeight / scale` by itself: compare against the zoomed height. */
export function shouldUseVisualViewportHeight(state: ViewportHeightState): boolean {
  if (!state.hasFocusedEditable) return false;
  const scale = state.viewportScale > 0 ? state.viewportScale : 1;
  return state.innerHeight / scale - state.viewportHeight > KEYBOARD_MIN_HEIGHT_PX;
}

function hasFocusedEditableElement(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return (
    active.isContentEditable ||
    active.tagName === "INPUT" ||
    active.tagName === "SELECT" ||
    active.tagName === "TEXTAREA"
  );
}

// WebKit reports the shrunken visual viewport only once the keyboard animation ends (bugs.webkit.org 265578), and an
// IME candidate bar resizes the keyboard with no event at all: after a trigger, the geometry is read again a few times.
const SETTLE_DELAYS_MS = [48, 120, 240, 420, 720] as const;

const WINDOW_EVENTS = ["resize", "focusin", "focusout", "pageshow"] as const;
const VIEWPORT_EVENTS = ["resize", "scroll"] as const;
const EDITABLE_EVENTS = [
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "input",
  "keyup",
] as const;

/**
 * While an editor has focus and the keyboard is open, `--app-viewport-height` follows the visual viewport and
 * `<html data-keyboard-open>` is set (anything fixed to the bottom lives inside that height). Both are removed on
 * unmount, with every listener, pending frame and pending re-read.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame: number | null = null;
    let chainTimer: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      frame = null;
      const open = shouldUseVisualViewportHeight({
        hasFocusedEditable: hasFocusedEditableElement(),
        innerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportScale: viewport.scale,
      });
      if (open) {
        root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
        root.dataset["keyboardOpen"] = "true";
      } else {
        root.style.removeProperty("--app-viewport-height");
        delete root.dataset["keyboardOpen"];
      }
      // iOS may scroll the page itself when the keyboard opens; an unzoomed page goes back to the top.
      if ((window.scrollX !== 0 || window.scrollY !== 0) && Math.abs(viewport.scale - 1) < 0.01) {
        window.scrollTo(0, 0);
      }
    };

    // The resize event can fire before `visualViewport.height` settles: read it on the next frame.
    const scheduleFrame = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    // One chain at a time: a keystroke mid-chain must not restart it, or typing would push the last re-read away.
    const runChain = () => {
      if (chainTimer !== null) return;
      let index = 0;
      const step = () => {
        const delay = SETTLE_DELAYS_MS[index++];
        if (delay === undefined) {
          chainTimer = null;
          return;
        }
        chainTimer = setTimeout(() => {
          update();
          step();
        }, delay);
      };
      step();
    };

    const trigger = () => {
      scheduleFrame();
      runChain();
    };
    const onEditableActivity = () => {
      if (hasFocusedEditableElement()) trigger();
    };

    trigger();
    for (const type of VIEWPORT_EVENTS) viewport.addEventListener(type, trigger);
    for (const type of WINDOW_EVENTS) window.addEventListener(type, trigger);
    for (const type of EDITABLE_EVENTS) document.addEventListener(type, onEditableActivity);

    return () => {
      for (const type of VIEWPORT_EVENTS) viewport.removeEventListener(type, trigger);
      for (const type of WINDOW_EVENTS) window.removeEventListener(type, trigger);
      for (const type of EDITABLE_EVENTS) document.removeEventListener(type, onEditableActivity);
      if (frame !== null) cancelAnimationFrame(frame);
      if (chainTimer !== null) clearTimeout(chainTimer);
      root.style.removeProperty("--app-viewport-height");
      delete root.dataset["keyboardOpen"];
    };
  }, []);
}
