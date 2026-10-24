import "../../i18n/register-github.ts";
import type { CheckView } from "@pap/contracts";
import { Chip, type ChipTone } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

const CHECK_TONE: Record<CheckView["state"], ChipTone> = {
  success: "ok",
  running: "run",
  failure: "err",
  neutral: "mut",
};

/** A check's state as a chip with its word (colour is never the only signal, §2). */
export function CheckChip({ state }: { readonly state: CheckView["state"] }) {
  const t = useT();
  return <Chip tone={CHECK_TONE[state]} label={t(`github.check.${state}`)} />;
}
