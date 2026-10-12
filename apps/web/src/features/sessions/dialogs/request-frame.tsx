import type { Dialog } from "@pap/contracts";
import { useT, type Translate } from "../../../i18n/index.ts";
import { plain, clip } from "./untrusted.ts";
import { ExpandToggle, useClipped } from "./use-clipped.tsx";

const TITLE_LIMITS = { lines: 2, chars: 200 } as const;
const MESSAGE_LIMITS = { lines: 8, chars: 1000 } as const;

/** "Closes on its own after N s", static text: Pi resolves the dialog itself (M2R131). */
export const timeoutLine = (timeout: number, t: Translate): string =>
  t("dialog.timeout", { seconds: Math.max(1, Math.round(timeout / 1000)) });

/** A title as a field label: invisible characters out, cut at the title limit, never expandable. */
export const titleText = (text: string): string => clip(plain(text), TITLE_LIMITS).shown;

/**
 * What `InputRequestCard` needs of an extension's dialog besides its answers: the extension's words stripped of
 * invisible characters and clipped until the owner expands them, and pap's own fixed texts. The card says
 * "from an extension" and never "Approval": an extension cannot make its dialog pass for the policy's approval (R101).
 */
export function useRequestFrame(dialog: Dialog, titleInField: boolean) {
  const t = useT();
  const title = useClipped(dialog.title, TITLE_LIMITS);
  const message = useClipped(dialog.message ?? "", MESSAGE_LIMITS);
  return {
    sourceLabel: t("source.extension"),
    detailsLabel: t("dialog.details"),
    title: title.shown,
    titleExpanded: title.expanded,
    titleControl: titleInField ? undefined : <ExpandToggle {...title} />,
    message: message.shown,
    messageExpanded: message.expanded,
    messageControl: <ExpandToggle {...message} />,
    timeoutLine: dialog.timeout === undefined ? undefined : timeoutLine(dialog.timeout, t),
  };
}
