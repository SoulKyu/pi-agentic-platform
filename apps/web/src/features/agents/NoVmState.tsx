import { EmptyState } from "@pap/ui";
import { agentsPhoneEn, agentsPhoneFr } from "../../i18n/catalog/agents-phone.ts";
import { registerCatalog, useT } from "../../i18n/index.ts";

registerCatalog({ en: agentsPhoneEn, fr: agentsPhoneFr });

/** What the owner sees where an agent would be made when the VM stack is unusable: why, and no action. */
export function NoVmState() {
  const t = useT();
  return <EmptyState title={t("agentsPhone.noVmTitle")} purpose={t("agentsPhone.noVmPurpose")} />;
}
