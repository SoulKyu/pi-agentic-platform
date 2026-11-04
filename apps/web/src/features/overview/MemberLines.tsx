import type { OverviewMemberLine } from "@pap/contracts";
import { Heading, cn, formatCost, useIsPhone } from "@pap/ui";
import { useLocale, useT } from "../../i18n/index.ts";
import { sizeText } from "./overview.vm.ts";

/** The owner's view of a member: counts and cost, never a name of anything they own (M14). */
export function MemberLines({ members }: { readonly members: readonly OverviewMemberLine[] }) {
  const t = useT();
  const locale = useLocale();
  const phone = useIsPhone();
  return (
    <section data-member-lines="" className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("overview.group.members")}
      </Heading>
      <ul className="flex flex-col gap-s1">
        {members.map((member) => (
          <li
            key={member.userId}
            className={cn(
              "grid items-baseline gap-s2 rounded-md border border-border bg-surface px-s3 py-s2 text-ui",
              phone ? "grid-cols-2" : "grid-cols-3",
            )}
          >
            <span className={cn("font-semibold text-fg", phone ? "col-span-2" : "col-span-3")}>
              {t("overview.member.name", { name: member.name })}
            </span>
            <Figure
              label={t("overview.member.boxes")}
              value={String(member.activeBoxes)}
              zero={member.activeBoxes === 0}
            />
            <Figure
              label={t("overview.member.memory")}
              value={sizeText(member.reservedMb, locale, t)}
              zero={member.reservedMb === 0}
            />
            <Figure
              label={t("overview.member.cost")}
              zero={member.costUsd === 0}
              value={
                member.budgetUsd === null
                  ? formatCost(member.costUsd)
                  : `${formatCost(member.costUsd)} / ${formatCost(member.budgetUsd)}`
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A 0 is muted: the eye goes to the members who use something. */
function Figure({
  label,
  value,
  zero,
}: {
  readonly label: string;
  readonly value: string;
  readonly zero: boolean;
}) {
  return (
    <span className="flex flex-col gap-s1">
      <span className="label-hud text-muted">{label}</span>
      <span
        data-figure-value=""
        {...(zero ? { "data-zero": "" } : {})}
        className={cn("font-mono tabular-nums", zero ? "text-muted" : "text-fg")}
      >
        {value}
      </span>
    </span>
  );
}
