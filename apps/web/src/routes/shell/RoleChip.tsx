import { Chip } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useRole } from "../../lib/role-context.ts";

/** OWNER or MEMBER beside the user name: mono uppercase, neutral tone, always the word. */
export function RoleChip() {
  const t = useT();
  const role = useRole();
  return (
    <span data-slot="role-chip" className="max-w-full">
      <Chip tone="mut" label={t(`shell.role.${role}`)} />
    </span>
  );
}
