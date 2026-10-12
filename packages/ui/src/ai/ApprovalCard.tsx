import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";
import { once } from "../once.ts";
import { Button } from "../primitives/Button.tsx";
import { Chip } from "../primitives/Chip.tsx";

/** M2's contract names (agreement 6). P3 pins this union to the one in @pap/contracts with a type-level test. */
export type ApprovalAnswer = "deny" | "once" | "session" | "always";
/** DESIGN.md §9.2 order. */
export const APPROVAL_ORDER: readonly ApprovalAnswer[] = ["deny", "session", "always", "once"];

interface ApprovalCardCommon {
  readonly title: string;
  /** The complete, already escaped text of the request. Its first line is a header (size, lines, hidden characters). */
  readonly detail: string;
  /** DESIGN.md §9.2 header: "Approval · <category>". */
  readonly category?: string;
  /** Shown as the dashed "external content" chip when the run is tainted (spec C §5). */
  readonly taintLabel?: string;
  /** Diff stats, trigger, tests. */
  readonly context?: ReactNode;
  /** What the policy asks, in its own words: shown under the heading, above the detail. Already escaped. */
  readonly question?: ReactNode;
  /** Buttons that change what is shown (expand, collapse): under the context, never part of the description. */
  readonly controls?: ReactNode;
  /** A line under the answers ("Closes on its own after 30 s"). */
  readonly note?: ReactNode;
  /** Names the header when the caller lets it scroll (it then takes the keyboard like the body does). */
  readonly headerLabel?: string | undefined;
}

/** The answers offered, their labels, one callback per click. */
export interface ApprovalCardProps extends ApprovalCardCommon {
  /** Shown in DESIGN order whatever the order given; "deny" is always offered. Default: all four. */
  readonly answers?: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  onChoose(answer: ApprovalAnswer): void;
}

interface Choice {
  readonly answers: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  choose(answer: ApprovalAnswer): void;
}

/** The answers offered in DESIGN order, "deny" always among them. */
function choiceOf(props: ApprovalCardProps): Choice {
  const offered = new Set<ApprovalAnswer>(props.answers ?? APPROVAL_ORDER);
  offered.add("deny");
  return {
    answers: APPROVAL_ORDER.filter((answer) => offered.has(answer)),
    labels: props.labels,
    choose: (answer) => props.onChoose(answer),
  };
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
  const { answers, labels, choose } = choiceOf(props);
  // The card can stay open for minutes: the answer goes to the latest callback, not the first render's.
  const latestChoose = useRef(choose);
  useEffect(() => {
    latestChoose.current = choose;
  });
  // Built on the first click, never during render: every button shares it for the card's whole life.
  const guard = useRef<((answer: ApprovalAnswer) => boolean) | null>(null);
  const answer = (choice: ApprovalAnswer) => {
    // `??=` is not supported by the React Compiler: an explicit check keeps the component memoized.
    if (guard.current === null) {
      guard.current = once((value: ApprovalAnswer) => {
        setAnswered(true);
        latestChoose.current(value);
      });
    }
    guard.current(choice);
  };
  const questionId = useId();
  const headerId = useId();
  const bodyId = useId();
  const contextId = useId();
  const { header, body } = splitDetail(props.detail);
  const described = [
    props.question ? questionId : "",
    header === null ? "" : headerId,
    body === "" ? "" : bodyId,
    props.context ? contextId : "",
  ]
    .filter(Boolean)
    .join(" ");
  const scrollingHeader = props.headerLabel
    ? ({ role: "region", tabIndex: 0, "aria-label": props.headerLabel } as const)
    : {};
  return (
    <section
      role="alertdialog"
      // Escape closes or cancels the card's own surface and never stops the run (the dispatcher's `inlineEditFocus`).
      data-inline-edit
      aria-label={props.category ? `${props.title} ${props.category}` : props.title}
      aria-describedby={described || undefined}
      className="rounded-md border border-attn-line bg-attn-tint p-s3"
    >
      <h3 className="flex flex-wrap items-center gap-s2 label-hud text-attn-title">
        <span>{props.title}</span>
        {props.category ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{props.category}</span>
          </>
        ) : null}
        {props.taintLabel ? <Chip tone="ext" label={props.taintLabel} /> : null}
      </h3>
      {props.question ? (
        <div id={questionId} className="mt-s2">
          {props.question}
        </div>
      ) : null}
      {header === null ? null : (
        <pre
          data-approval-header
          id={headerId}
          {...scrollingHeader}
          className={cn(
            "mt-s2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ui font-semibold text-fg",
            props.headerLabel ? FOCUS_RING : null,
          )}
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
            "mt-s1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-bg p-s2 font-mono text-ui text-fg",
            FOCUS_RING,
          )}
        >
          {body}
        </pre>
      )}
      {props.context ? (
        <div id={contextId} className="mt-s2 text-ui text-muted">
          {props.context}
        </div>
      ) : null}
      {props.controls ? <div className="mt-s2 flex flex-wrap gap-s2">{props.controls}</div> : null}
      <div className="mt-s3 flex flex-wrap gap-s2">
        {answers.map((choice) => (
          <Button
            key={choice}
            variant={choice === "once" ? "primary" : "secondary"}
            disabled={answered}
            onClick={() => answer(choice)}
          >
            {labels[choice]}
          </Button>
        ))}
      </div>
      {props.note ? <div className="mt-s2 text-label text-muted">{props.note}</div> : null}
    </section>
  );
}
