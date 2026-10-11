import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";
import { once } from "../once.ts";
import { Button } from "../primitives/Button.tsx";

export interface ApprovalCardProps {
  readonly title: string;
  /** The complete, already escaped text of the request. Its first line is a header (size, lines, hidden characters). */
  readonly detail: string;
  readonly allowLabel: string;
  readonly denyLabel: string;
  onAnswer(approved: boolean): void;
}

/** The header is the first line; the rest scrolls beneath it, so a long or blank-padded detail cannot hide the header. */
function splitDetail(detail: string): { header: string | null; body: string } {
  const end = detail.indexOf("\n");
  return end === -1
    ? { header: null, body: detail }
    : { header: detail.slice(0, end), body: detail.slice(end + 1) };
}

/** Pink = waiting for you. One card is one request: key it by request id. It answers once, whatever is clicked next. */
export function ApprovalCard(props: ApprovalCardProps) {
  const [answered, setAnswered] = useState(false);
  // The card can stay open for minutes: the answer goes to the latest callback, not the first render's.
  const latestOnAnswer = useRef(props.onAnswer);
  useEffect(() => {
    latestOnAnswer.current = props.onAnswer;
  });
  // Built on the first click, never during render: both buttons share it for the card's whole life.
  const guard = useRef<((approved: boolean) => boolean) | null>(null);
  const answer = (approved: boolean) => {
    // `??=` is not supported by the React Compiler: an explicit check keeps the component memoized.
    if (guard.current === null) {
      guard.current = once((value: boolean) => {
        setAnswered(true);
        latestOnAnswer.current(value);
      });
    }
    guard.current(approved);
  };
  const headerId = useId();
  const bodyId = useId();
  const { header, body } = splitDetail(props.detail);
  const described = [header === null ? "" : headerId, body === "" ? "" : bodyId].filter(Boolean).join(" ");
  return (
    <section
      role="alertdialog"
      aria-label={props.title}
      aria-describedby={described || undefined}
      className="rounded-md border border-attention-line bg-attention-tint p-3"
    >
      <h3 className="font-mono text-label font-semibold uppercase tracking-label text-attention">
        {props.title}
      </h3>
      {header === null ? null : (
        <pre
          data-approval-header
          id={headerId}
          className="mt-2 whitespace-pre-wrap break-all font-mono text-ui font-semibold text-fg"
        >
          {header}
        </pre>
      )}
      {body === "" ? null : (
        <pre
          data-approval-scroll
          id={bodyId}
          role="region"
          aria-labelledby={header === null ? undefined : headerId}
          aria-label={header === null ? props.title : undefined}
          tabIndex={0}
          className={cn(
            "mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-bg p-2 font-mono text-ui text-fg",
            FOCUS_RING,
          )}
        >
          {body}
        </pre>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={answered} onClick={() => answer(true)}>
          {props.allowLabel}
        </Button>
        <Button variant="secondary" disabled={answered} onClick={() => answer(false)}>
          {props.denyLabel}
        </Button>
      </div>
    </section>
  );
}
