import { Icon, IconWarning } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/index.ts";

const BROKEN: ReadonlyArray<string> = ["lanes.pr.error.failed", "lanes.pr.error.not_found"];

/** DESIGN.md §11: a status that could not be read is red with the warning icon; a sign-in the person must do stays pink. */
export function PrError({ message }: { readonly message: MessageKey }) {
  const t = useT();
  if (!BROKEN.includes(message)) return <span className="text-attn">{t(message)}</span>;
  return (
    <span className="inline-flex items-center gap-s1 text-err">
      <Icon icon={IconWarning} size={14} />
      {t(message)}
    </span>
  );
}
