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
}

/** The converged API (agreement 6): the answers offered, their labels, one callback per click. */
export interface ApprovalCardChoiceProps extends ApprovalCardCommon {
  /** Shown in DESIGN order whatever the order given; "deny" is always offered. Default: all four. */
  readonly answers?: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  onChoose(answer: ApprovalAnswer): void;
}

/** M1's props, kept until post-merge task P1 (agreement 5): Deny and Allow once. */
export interface ApprovalCardM1Props extends ApprovalCardCommon {
  readonly allowLabel: string;
  readonly denyLabel: string;
  onAnswer(approved: boolean): void;
}

export type ApprovalCardProps = ApprovalCardChoiceProps | ApprovalCardM1Props;

interface Choice {
  readonly answers: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  choose(answer: ApprovalAnswer): void;
}

/** One path for both prop shapes: the M1 props are the answers Deny and Allow once. Keys are unique by construction. */
function choiceOf(props: ApprovalCardProps): Choice {
  if ("onChoose" in props) {
    const offered = new Set<ApprovalAnswer>(props.answers ?? APPROVAL_ORDER);
    offered.add("deny");
    return {
      answers: APPROVAL_ORDER.filter((answer) => offered.has(answer)),
      labels: props.labels,
      choose: (answer) => props.onChoose(answer),
    };
  }
  return {
    answers: ["deny", "once"],
    labels: { deny: props.denyLabel, once: props.allowLabel, session: "", always: "" },
    choose: (answer) => props.onAnswer(answer !== "deny"),
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
  const headerId = useId();
  const bodyId = useId();
  const { header, body } = splitDetail(props.detail);
  const described = [header === null ? "" : headerId, body === "" ? "" : bodyId].filter(Boolean).join(" ");
  return (
    <section
      role="alertdialog"
      aria-label={props.title}
      aria-describedby={described || undefined}
      className="rounded-md border border-attn-line bg-attn-tint p-s3"
    >
      <h3 className="flex flex-wrap items-center gap-s2 label-hud text-attn-title">
        <span>{props.title}</span>
        {props.category ? (
          <>
            <span aria-hidden>·</span>
            <span>{props.category}</span>
          </>
        ) : null}
        {props.taintLabel ? <Chip tone="ext" label={props.taintLabel} /> : null}
      </h3>
      {header === null ? null : (
        <pre
          data-approval-header
          id={headerId}
          className="mt-s2 whitespace-pre-wrap break-all font-mono text-ui font-semibold text-fg"
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
      {props.context ? <div className="mt-s2 text-ui text-muted">{props.context}</div> : null}
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
    </section>
  );
}
