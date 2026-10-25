import { Icon, IconCheck, IconFailed } from "@pap/ui";
import { plural, useLocale } from "../../i18n/index.ts";
import type { PrBadge } from "./lane-header.vm.ts";

/** One CI tally of a pull request: an icon (a word for pending), the count, and the status in words for a screen reader. */
export function CheckCount({
  kind,
  count,
}: {
  readonly kind: PrBadge["checks"][number]["kind"];
  readonly count: number;
}) {
  const locale = useLocale();
  return (
    <span className={`inline-flex items-center gap-s1 ${kind === "failed" ? "text-err" : ""}`}>
      {kind === "passed" ? <Icon icon={IconCheck} size={14} /> : null}
      {kind === "failed" ? <Icon icon={IconFailed} size={14} /> : null}
      {kind === "pending" ? <span aria-hidden="true">…</span> : null}
      {count}
      <span className="sr-only">{` ${plural(locale, `lanes.pr.checks.${kind}`, count)}`}</span>
    </span>
  );
}
