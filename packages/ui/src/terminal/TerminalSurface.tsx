import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { terminalTheme, tokenReader } from "./terminal-theme.ts";

/** What the owner of the surface drives: bytes in order, a reset after them, the focus. */
export interface TerminalScreen {
  /** Resolves once xterm has the bytes on screen, or when the surface goes away; rejects when xterm refuses them. */
  write(bytes: Uint8Array): Promise<void>;
  /** Runs after every write queued before it. */
  reset(): void;
  focus(): void;
  /** `term.paste(text)`: xterm turns new lines into CR and wraps a bracketed paste itself, and the text reaches `onData`. */
  paste(text: string): void;
  /** The program in the terminal asked for bracketed paste (`term.modes.bracketedPasteMode`). */
  bracketedPaste(): boolean;
}

export interface TerminalSurfaceProps {
  /** Accessible name of the terminal. */
  readonly label: string;
  /** The screen once the terminal is open, `null` when it is gone. */
  onScreen(screen: TerminalScreen | null): void;
  /** What xterm sends to the shell: keys, pasted text, and its own replies to device queries. */
  onData(data: string): void;
  /** The binary form of the same (mouse reports): a string of code points 0-255. */
  onBinary(data: string): void;
  /** The size of this pane's own container, when it changes. A size the server reports never comes back here. */
  onResize(cols: number, rows: number): void;
  /** Ctrl+] was pressed: the owner takes the focus out. */
  onLeave(): void;
}

const SCROLLBACK = 5000;
const DEFAULT_FONT_PX = 12;
const SAFE_SCHEMES = new Set(["http:", "https:"]);

/** OSC 8 links: only http and https open, in a window with no opener (the CSP is not the only guard, RT-33). */
function openLink(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (SAFE_SCHEMES.has(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
}

/** WebGL when the browser has it and the addon activates; otherwise xterm keeps its DOM renderer. */
function loadWebgl(term: Terminal): WebglAddon | null {
  // No probe context: the browsers cap live contexts, and activation below is the real test.
  if (typeof WebGL2RenderingContext === "undefined") return null;
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    addon.onContextLoss(() => addon?.dispose());
    term.loadAddon(addon);
    return addon;
  } catch {
    addon?.dispose();
    return null;
  }
}

/** xterm 6 over the pap tokens. Terminal output is only ever written to xterm, never rendered as HTML. */
export function TerminalSurface(props: TerminalSurfaceProps) {
  const { label } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // The callbacks are read when an event fires, so a new closure never recreates the terminal.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;
    if (!root || !host) return;
    const style = getComputedStyle(root);
    const fontSize = Number.parseFloat(style.getPropertyValue("--size-code")) || DEFAULT_FONT_PX;
    const term = new Terminal({
      scrollback: SCROLLBACK,
      cursorBlink: false,
      allowProposedApi: false,
      fontFamily: style.getPropertyValue("--font-code").trim() || "monospace",
      minimumContrastRatio: 4.5,
      fontSize,
      theme: terminalTheme(tokenReader(document.documentElement)),
      linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const gl = loadWebgl(term);

    let disposed = false;
    const unsettled = new Set<() => void>();
    const screen: TerminalScreen = {
      write: (bytes) =>
        new Promise<void>((resolve, reject) => {
          if (disposed) return resolve();
          unsettled.add(resolve);
          try {
            term.write(bytes, () => {
              unsettled.delete(resolve);
              resolve();
            });
          } catch (failure) {
            unsettled.delete(resolve);
            reject(failure as Error);
          }
        }),
      reset: () => {
        // xterm runs its write queue in order: an empty write is the marker that comes after the queued ones.
        term.write("", () => {
          if (!disposed) term.reset();
        });
      },
      focus: () => term.focus(),
      paste: (text) => term.paste(text),
      bracketedPaste: () => term.modes.bracketedPasteMode,
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && !event.altKey && !event.metaKey && event.key === "]") {
        term.blur();
        latest.current.onLeave();
        return false;
      }
      return true;
    });
    const subscriptions = [
      term.onData((data) => latest.current.onData(data)),
      term.onBinary((data) => latest.current.onBinary(data)),
    ];

    let reported = "";
    const report = () => {
      const size = `${term.cols}x${term.rows}`;
      if (size === reported) return;
      reported = size;
      latest.current.onResize(term.cols, term.rows);
    };
    const fitAndReport = () => {
      try {
        fit.fit();
      } catch {
        return; // not laid out yet: the observer fires again
      }
      report();
    };
    // Only the pane's own box: a size from the server is never applied here, so two clients cannot resize each other.
    const resizes = new ResizeObserver(fitAndReport);
    resizes.observe(root);
    fitAndReport();

    const themes = new MutationObserver(() => {
      term.options.theme = terminalTheme(tokenReader(document.documentElement));
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    latest.current.onScreen(screen);
    return () => {
      disposed = true;
      latest.current.onScreen(null);
      resizes.disconnect();
      themes.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      gl?.dispose();
      term.dispose();
      for (const resolve of unsettled) resolve();
      unsettled.clear();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-slot="terminal"
      data-terminal-input
      role="group"
      aria-label={label}
      className="h-full min-h-0 w-full overflow-hidden bg-bg p-s2"
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
