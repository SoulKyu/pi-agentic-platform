import type { Dialog } from "@pap/contracts";
import { cn, FOCUS_RING } from "@pap/ui";
import { useId, type ReactNode } from "react";
import { t } from "../../../i18n/index.ts";
import { plain, clip } from "./untrusted.ts";
import { ExpandToggle, useClipped } from "./use-clipped.tsx";

const TITLE_LIMITS = { lines: 2, chars: 200 } as const;
const MESSAGE_LIMITS = { lines: 8, chars: 1000 } as const;

/** "Closes on its own after N s", static text: Pi resolves the dialog itself (M2R131). */
export const timeoutLine = (timeout: number): string =>
  t("dialog.timeout", { seconds: Math.max(1, Math.round(timeout / 1000)) });

/** A title as a field label: invisible characters out, cut at the title limit, never expandable. */
export const titleText = (text: string): string => clip(plain(text), TITLE_LIMITS).shown;

/**
 * The frame of an extension's dialog. It is deliberately plain (no attention tint, no "Approval" word): an extension
 * cannot make its dialog pass for the policy's approval (R101). Everything it says is shown as clipped text.
 */
export function ExtensionCard(props: {
  readonly dialog: Dialog;
  /** True when the title is shown by a field's own label instead of a heading. */
  readonly titleInField?: boolean;
  readonly children: ReactNode;
}) {
  const { dialog } = props;
  const headingId = useId();
  const title = useClipped(dialog.title, TITLE_LIMITS);
  const message = useClipped(dialog.message ?? "", MESSAGE_LIMITS);
  return (
    <section
      role="group"
      aria-labelledby={props.titleInField ? undefined : headingId}
      aria-label={props.titleInField ? title.shown : undefined}
      className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3"
    >
      <p
        data-extension-label
        className="font-mono text-label font-semibold uppercase tracking-label text-muted"
      >
        {t("source.extension")}
      </p>
      {props.titleInField ? null : (
        <>
          <div
            data-title-scroll
            {...(title.expanded ? { role: "region", tabIndex: 0, "aria-labelledby": headingId } : {})}
            className={cn("max-h-32 overflow-auto", FOCUS_RING)}
          >
            <h3 id={headingId} className="whitespace-pre-wrap break-words text-ui font-semibold text-fg">
              {title.shown}
            </h3>
          </div>
          <ExpandToggle {...title} />
        </>
      )}
      {message.shown === "" ? null : (
        <>
          <p
            data-clipped
            tabIndex={message.expanded ? 0 : undefined}
            role={message.expanded ? "region" : undefined}
            aria-label={message.expanded ? t("dialog.details") : undefined}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-ui text-fg"
          >
            {message.shown}
          </p>
          <ExpandToggle {...message} />
        </>
      )}
      {props.children}
      {dialog.timeout === undefined ? null : (
        <p className="text-label text-muted">{timeoutLine(dialog.timeout)}</p>
      )}
    </section>
  );
}
