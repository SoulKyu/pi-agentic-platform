import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { once } from "../once.ts";
import { Button } from "../primitives/Button.tsx";
import { Chip } from "../primitives/Chip.tsx";

/** M2's contract names (agreement 6). P3 pins this union to the one in @pap/contracts with a type-level test. */
export type ApprovalAnswer = "deny" | "once" | "session" | "always" | "host";
/** DESIGN.md §9.2 order; `host` (owner a2) sits between Always and Allow once. */
export const APPROVAL_ORDER: readonly ApprovalAnswer[] = ["deny", "session", "always", "host", "once"];

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
  /** Buttons that change what is shown (expand, collapse), choices: next to the answers, never part of the description. */
  readonly controls?: ReactNode;
  /** A line under the answers ("Closes on its own after 30 s"). */
  readonly note?: ReactNode;
  /**
   * Compact form: a long command shows its first lines (never hidden) with a button for the rest. The labels are the
   * button's two states; without this prop the whole text is shown in its scrolling box.
   */
  readonly collapse?: { readonly show: string; readonly hide: string; readonly blocked: string } | undefined;
  /** Part of the command is withheld by the caller (clipped, not yet asked for): allowing waits, like a collapsed one. */
  readonly withheld?: boolean | undefined;
  /** A phone's card: it fills its row and the answers share the full width as touch-sized buttons. */
  readonly wide?: boolean | undefined;
  /** The heading level of the title: 2 under a page title (default), 3 inside a section that has its own h2. */
  readonly level?: 2 | 3 | undefined;
}

/**
 * What the collapsed card shows of the command (and of its header line): at most this many lines and this many
 * characters. Anything beyond either limit makes it "long": Allow waits until the owner has expanded it once. Long lines
 * wrap, nothing is cut by a box or an ellipsis, and the expanded view has no inner scroll.
 */
const COLLAPSED_LINES = 2;
const COLLAPSED_CHARS = 300;
const cut = (text: string, lines: number): string =>
  [...text.split("\n").slice(0, lines).join("\n")].slice(0, COLLAPSED_CHARS).join("");
const isLong = (text: string, lines: number): boolean =>
  text.split("\n").length > lines || [...text].length > COLLAPSED_CHARS;
const BODY_CLASSES =
  "mt-s1 whitespace-pre-wrap break-all rounded-sm border border-border bg-bg p-s2 font-mono text-ui text-fg";

/** The answers offered, their labels, one callback per click. */
export interface ApprovalCardProps extends ApprovalCardCommon {
  /** Shown in DESIGN order whatever the order given; "deny" is always offered. Default: the four without `host`. */
  readonly answers?: readonly ApprovalAnswer[];
  /** `host` has a button only when it is offered and has a label: no card but the network request's asks for it. */
  readonly labels: Readonly<Record<Exclude<ApprovalAnswer, "host">, string>> & { readonly host?: string };
  onChoose(answer: ApprovalAnswer): void;
}

interface Choice {
  readonly answers: readonly ApprovalAnswer[];
  readonly labels: ApprovalCardProps["labels"];
  choose(answer: ApprovalAnswer): void;
}

/** The answers offered in DESIGN order, "deny" always among them. */
function choiceOf(props: ApprovalCardProps): Choice {
  const offered = new Set<ApprovalAnswer>(props.answers ?? ["deny", "session", "always", "once"]);
  offered.add("deny");
  return {
    answers: APPROVAL_ORDER.filter(
      (answer) => offered.has(answer) && (answer !== "host" || props.labels.host !== undefined),
    ),
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
  // Expansion belongs to one command text: a changed detail starts collapsed (and gated) again.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === props.detail;
  const { answers, labels, choose } = choiceOf(props);
  // The card can stay open for minutes: the answer goes to the latest callback, not the first render's.
  const latestChoose = useRef(choose);
  useEffect(() => {
    latestChoose.current = choose;
  });
  // Built on the first click, never during render: every button shares it for the card's whole life.
  const blockedRef = useRef<(choice: ApprovalAnswer) => boolean>(() => false);
  const guard = useRef<((answer: ApprovalAnswer) => boolean) | null>(null);
  const answer = (choice: ApprovalAnswer) => {
    if (blockedRef.current(choice)) return;
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
  // Compact form: a long header line or command is cut to the collapsed limits until the owner expands it.
  const longHeader = header !== null && isLong(header, 1);
  const longBody = isLong(body, COLLAPSED_LINES);
  const collapsible = props.collapse !== undefined && (longHeader || longBody);
  // A caller that withholds part of the command shows what it has whole: its own button asks for the rest.
  const withheld = props.withheld === true;
  const collapsed = collapsible && !expanded && !withheld;
  // Allowing needs the whole command on screen; Deny never waits.
  const waiting = collapsed || withheld;
  const blocked = (choice: ApprovalAnswer) => waiting && choice !== "deny";
  useEffect(() => {
    blockedRef.current = blocked;
  });
  const Heading = props.level === 3 ? "h3" : "h2";
  return (
    <section
      role="alertdialog"
      // Escape closes or cancels the card's own surface and never stops the run (the dispatcher's `inlineEditFocus`).
      data-inline-edit
      aria-label={props.category ? `${props.title} ${props.category}` : props.title}
      aria-describedby={described || undefined}
      className={cn("rounded-md border border-attn-line bg-attn-tint p-s2", props.wide && "w-full")}
    >
      <Heading className="flex flex-wrap items-center gap-s2 label-hud text-attn-title">
        <span>{props.title}</span>
        {props.category ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{props.category}</span>
          </>
        ) : null}
        {props.taintLabel ? <Chip tone="ext" label={props.taintLabel} /> : null}
      </Heading>
      {props.question ? (
        <div id={questionId} className="mt-s1">
          {props.question}
        </div>
      ) : null}
      {header === null ? null : (
        <pre
          data-approval-header
          id={headerId}
          className="mt-s1 whitespace-pre-wrap break-all font-mono text-ui font-semibold text-fg"
        >
          {collapsed ? cut(header, 1) : header}
        </pre>
      )}
      {body === "" ? null : (
        <pre
          data-approval-scroll
          data-collapsed={collapsed || undefined}
          id={bodyId}
          role="region"
          aria-labelledby={header === null ? undefined : headerId}
          aria-label={header === null ? props.title : undefined}
          className={BODY_CLASSES}
        >
          {collapsed ? cut(body, COLLAPSED_LINES) : body}
        </pre>
      )}
      {props.context ? (
        <div id={contextId} className="mt-s1 text-ui text-muted">
          {props.context}
        </div>
      ) : null}
      <div className="mt-s2 flex flex-wrap items-center gap-s2">
        {(collapsible && !withheld) || props.controls ? (
          <div className="flex min-w-0 flex-wrap items-center gap-s2">
            {collapsible && !withheld && props.collapse ? (
              <Button
                size="sm"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setExpandedFor(expanded ? null : props.detail)}
              >
                {expanded ? props.collapse.hide : props.collapse.show}
              </Button>
            ) : null}
            {props.controls}
          </div>
        ) : null}
        <div
          data-approval-actions
          className={cn(
            "order-last gap-s2",
            props.wide ? "grid w-full grid-cols-2" : "ml-auto flex flex-wrap",
          )}
        >
          {answers.map((choice) => (
            <Button
              key={choice}
              size="md"
              variant={choice === "once" ? "primary" : "secondary"}
              disabled={answered || blocked(choice)}
              onClick={() => answer(choice)}
            >
              {labels[choice]}
            </Button>
          ))}
        </div>
        {waiting && props.collapse ? (
          <div data-approval-blocked className="text-label text-attn-title">
            {props.collapse.blocked}
          </div>
        ) : null}
        {props.note ? <div className="text-label text-muted">{props.note}</div> : null}
      </div>
    </section>
  );
}
