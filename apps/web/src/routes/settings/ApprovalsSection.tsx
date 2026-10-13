import { ApprovalsPanel } from "../../features/policy/ApprovalsPanel.tsx";
import { useT } from "../../i18n/index.ts";

export function ApprovalsSection() {
  const t = useT();
  return (
    <div className="flex flex-col gap-s4">
      <p className="text-ui text-muted">{t("approvals.intro")}</p>
      <ApprovalsPanel />
    </div>
  );
}
