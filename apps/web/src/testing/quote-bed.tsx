import type { ReactNode } from "react";
import { act } from "react";

/** Two agent replies, one of yours and a tool card on screen `s1`, and an agent reply on screen `other`. */
export function QuoteFixture({ children }: { children?: ReactNode }) {
  return (
    <>
      <section data-pane-kind="session" data-session-screen="s1">
        <article data-slot="message" data-author="agent">
          <div data-markdown-body="">
            <p id="reply-1">First reply with a passage to quote</p>
          </div>
        </article>
        <article data-slot="message" data-author="agent">
          <div data-markdown-plain="">
            <p id="reply-2">Second reply</p>
          </div>
        </article>
        <article data-slot="message" data-author="you">
          <div>
            <p id="mine">my own words</p>
          </div>
        </article>
        <div data-tool-card="">
          <p id="tool">tool output</p>
        </div>
        <textarea id="composer" aria-label="composer" />
        {children}
      </section>
      <section data-session-screen="other">
        <article data-slot="message" data-author="agent">
          <div data-markdown-body="">
            <p id="elsewhere">another screen</p>
          </div>
        </article>
      </section>
    </>
  );
}

/** Selects from the start of one element's text to the end of another's (the same element by default), then says so. */
export async function select(from: string, to: string = from): Promise<void> {
  const start = document.getElementById(from)?.firstChild;
  const end = document.getElementById(to)?.firstChild;
  if (!start || !end) throw new Error("no such element to select");
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent?.length ?? 0);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

export async function clearSelection(): Promise<void> {
  document.getSelection()?.removeAllRanges();
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}
