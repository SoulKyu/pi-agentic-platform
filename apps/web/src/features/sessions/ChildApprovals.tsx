import { Heading } from "@pap/ui";
import "../../i18n/register-subagents.ts";
import type { ChildView } from "@pap/contracts";
import { useT } from "../../i18n/index.ts";
import { DialogList } from "./dialogs/DialogList.tsx";
import { titleOf } from "./SubagentBar.tsx";

/**
 * A child's open dialogs on its parent's screen (M11R154): M2's cards, labelled with the child's title and answered with the
 * CHILD's session id, so the permissions and receipts are the child's own. The title is the model's text (clean, clipped).
 */
export function ChildApprovals({ subagents }: { readonly subagents: readonly ChildView[] }) {
  const t = useT();
  const waiting = subagents.filter((child) => child.dialogs.length > 0 || child.hiddenDialogs > 0);
  if (waiting.length === 0) return null;
  return (
    <div data-child-approvals className="flex flex-col gap-s3">
      {waiting.map((child) => {
        const label = t("subagents.from", { title: titleOf(child) });
        return (
          <section key={child.id} aria-label={label} className="flex flex-col gap-s2">
            <Heading level={3} variant="card">
              {label}
            </Heading>
            <DialogList sessionId={child.id} dialogs={child.dialogs} hidden={child.hiddenDialogs} />
          </section>
        );
      })}
    </div>
  );
}
