import type { ApprovalAnswer } from "@pap/contracts";
import { Button, cn, FOCUS_RING } from "@pap/ui";
import { useId } from "react";
import { t } from "../../../i18n/index.ts";
import { splitApproval } from "../approval-detail.ts";
import { ExpandToggle, useClipped } from "./use-clipped.tsx";
import { useAnswer } from "./use-answer.ts";
import { plain } from "./untrusted.ts";

/** Left to right, as DESIGN §9 lists them: the refusal first, the one-off grant last. */
const ORDER: readonly ApprovalAnswer[] = ["deny", "session", "always", "once"];
const BODY_LIMITS = { lines: 200, chars: 4000 } as const;
const HEADER_LIMITS = { lines: 2, chars: 400 } as const;
const QUESTION_LIMITS = { lines: 3, chars: 300 } as const;

export interface ApprovalDialogProps {
  /** The translated header, in sentence case: the `uppercase` class shows it in capitals ("Approval · exec"). */
  readonly title: string;
  /** What the policy asks, in its own words: untrusted text. */
  readonly question: string;
  /** The policy's message: a header line, then the call. Untrusted text. */
  readonly detail: string | undefined;
  readonly answers: readonly ApprovalAnswer[];
  /** Static text for a dialog that closes on its own ("Closes on its own after 30 s"); Pi owns the timer. */
  readonly timeoutNote?: string | undefined;
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  onChoose(answer: ApprovalAnswer): void;
}

/** A clipped text that has been expanded can scroll: it becomes a named region the keyboard can reach. */
const scrollArea = (expanded: boolean, name: string) =>
  expanded ? ({ role: "region", tabIndex: 0, "aria-label": name } as const) : {};

/** Pink = the policy waits for you. One card is one request: key it by request id and attempt. */
export function ApprovalDialog(props: ApprovalDialogProps) {
  const { answered, answer } = useAnswer(props.onChoose);
  const titleId = useId();
  const headerId = useId();
  const bodyId = useId();
  const question = useClipped(props.question, QUESTION_LIMITS);
  const { header, body } = splitApproval(plain(props.detail ?? ""));
  const headerText = useClipped(header ?? "", HEADER_LIMITS);
  const bodyText = useClipped(body, BODY_LIMITS);
  const described = [header === null ? "" : headerId, body === "" ? "" : bodyId].filter(Boolean).join(" ");
  return (
    <section
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={described || undefined}
      className="flex flex-col gap-2 rounded-md border border-attention-line bg-attention-tint p-3"
    >
      <h3 id={titleId} className="font-mono text-label font-semibold uppercase tracking-label text-attention">
        {props.title}
      </h3>
      <p
        data-approval-question
        {...scrollArea(question.expanded, t("dialog.question"))}
        className={cn(
          "max-h-32 overflow-auto whitespace-pre-wrap break-words text-ui font-semibold text-fg",
          FOCUS_RING,
        )}
      >
        {question.shown}
      </p>
      <ExpandToggle {...question} />
      {header === null ? null : (
        <>
          <pre
            data-approval-header
            id={headerId}
            {...scrollArea(headerText.expanded, t("dialog.summary"))}
            className={cn(
              "max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ui font-semibold text-fg",
              FOCUS_RING,
            )}
          >
            {headerText.shown}
          </pre>
          <ExpandToggle {...headerText} />
        </>
      )}
      {body === "" ? null : (
        <>
          <pre
            data-approval-scroll
            id={bodyId}
            role="region"
            aria-labelledby={header === null ? titleId : headerId}
            tabIndex={0}
            className={cn(
              "max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-bg p-2 font-mono text-ui text-fg",
              FOCUS_RING,
            )}
          >
            {bodyText.shown}
          </pre>
          <ExpandToggle {...bodyText} />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {ORDER.filter((name) => props.answers.includes(name)).map((name) => (
          <Button
            key={name}
            variant={name === "once" ? "primary" : "secondary"}
            disabled={answered}
            onClick={() => answer(name)}
          >
            {props.labels[name]}
          </Button>
        ))}
      </div>
      {props.timeoutNote ? <p className="text-label text-muted">{props.timeoutNote}</p> : null}
    </section>
  );
}
