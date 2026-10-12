import { useId, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";
import { InputRequestBody, type InputRequestAnswers } from "./InputRequestBody.tsx";

interface Frame {
  /** Says whose request this is ("from an extension"). It is pap's fixed text; everything else is the extension's. */
  readonly sourceLabel: string;
  /** The title as it is shown: already stripped and clipped by the caller. */
  readonly title: string;
  /** The caller's clipped title was expanded: it scrolls, so it becomes a named region the keyboard can reach. */
  readonly titleExpanded?: boolean;
  /** The caller's "show more" button for the title. */
  readonly titleControl?: ReactNode;
  readonly message?: string | undefined;
  readonly messageExpanded?: boolean;
  readonly messageControl?: ReactNode;
  /** Names the message region once it scrolls. */
  readonly detailsLabel: string;
  /** "Closes on its own after 30 s": static text, the host resolves the request itself. */
  readonly timeoutLine?: string | undefined;
}

export type InputRequestCardProps = Frame & InputRequestAnswers & { readonly answered: boolean };

/**
 * An extension's own select / confirm / text question. It is deliberately plain (no attention tint, no "Approval"
 * word): an extension cannot make its request pass for the policy's approval. The caller strips and clips the
 * extension's text; the card shows it as text. The root is an inline edit, so Escape closes the card's own surface and
 * never stops the run.
 */
export function InputRequestCard(props: InputRequestCardProps) {
  const headingId = useId();
  const inField = props.kind === "text";
  return (
    <section
      role="group"
      data-inline-edit
      aria-labelledby={inField ? undefined : headingId}
      aria-label={inField ? props.title : undefined}
      className="flex flex-col gap-s2 rounded-md border border-border bg-surface p-s3"
    >
      <p data-extension-label className="label-hud text-muted">
        {props.sourceLabel}
      </p>
      {inField ? null : (
        <>
          <div
            data-title-scroll
            {...(props.titleExpanded ? { role: "region", tabIndex: 0, "aria-labelledby": headingId } : {})}
            className={cn("max-h-32 overflow-auto", FOCUS_RING)}
          >
            <h3 id={headingId} className="whitespace-pre-wrap break-words text-ui font-semibold text-fg">
              {props.title}
            </h3>
          </div>
          {props.titleControl}
        </>
      )}
      {props.message ? (
        <>
          <p
            data-clipped
            tabIndex={props.messageExpanded ? 0 : undefined}
            role={props.messageExpanded ? "region" : undefined}
            aria-label={props.messageExpanded ? props.detailsLabel : undefined}
            className={cn(
              "max-h-64 overflow-auto whitespace-pre-wrap break-words text-ui text-fg",
              props.messageExpanded ? FOCUS_RING : null,
            )}
          >
            {props.message}
          </p>
          {props.messageControl}
        </>
      ) : null}
      <InputRequestBody {...props} fieldLabel={props.title} />
      {props.timeoutLine ? <p className="text-label text-muted">{props.timeoutLine}</p> : null}
    </section>
  );
}
