import type { TaintCauses } from "@pap/contracts";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import "../register-policy-catalog.ts";

/** How many causes the line names; the rest are counted. */
const NAMED = 2;

/** The causes of a taint on one line: the two newest tools, their time (24 hours, local), and how many more there were. */
export function TaintCauseLine({ causes }: { readonly causes: TaintCauses }) {
  const t = useT();
  const locale = useLocale();
  if (causes.list.length === 0 && causes.older === 0) return null;
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const named = causes.list
    .slice(-NAMED)
    .map((cause) =>
      t(cause.count > 1 ? "sessionPolicy.cause.itemMany" : "sessionPolicy.cause.item", {
        tool: cause.tool,
        time: clock.format(cause.at),
        count: cause.count,
      }),
    )
    .join(", ");
  const more = Math.max(0, causes.list.length - NAMED) + causes.older;
  return (
    <p data-approval-taint className="mt-s1 break-words text-ui text-muted">
      {t("sessionPolicy.cause.lead")}{" "}
      <span className="font-mono text-fg">
        {more > 0 ? `${named} ${plural(locale, "sessionPolicy.cause.more", more)}` : named}
      </span>
    </p>
  );
}
