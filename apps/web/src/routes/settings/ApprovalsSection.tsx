import { useT } from "../../i18n/index.ts";

/** The policy panels (rules, audit) are added below the intro by the tasks that build them. */
export function ApprovalsSection() {
  const t = useT();
  return <p className="text-ui text-muted">{t("approvals.intro")}</p>;
}
