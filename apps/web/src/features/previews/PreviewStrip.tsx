import "../../i18n/register-previews.ts";
import type { BoxRef } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useMemo } from "react";
import { useT } from "../../i18n/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { runningOf } from "./preview-box.ts";
import { targetOf, type PreviewTarget } from "./previews.vm.ts";

interface Props {
  readonly box: BoxRef;
  /** The shell opens the preview beside the session (features never import the workspace). */
  onOpen(target: PreviewTarget): void;
}

/**
 * One line per running service of the box, above the composer (UX2-R38): the name, the port and OPEN PREVIEW. Polite,
 * and nothing while none runs or the stream has not given its first snapshot.
 */
export function PreviewStrip({ box, onOpen }: Props) {
  const t = useT();
  const services = usePreviewsStore((state) => state.services);
  const ready = usePreviewsStore((state) => state.ready);
  const running = useMemo(() => (ready ? runningOf(services, box) : []), [ready, services, box]);
  return (
    <div data-slot="preview-strip" aria-live="polite" className="flex flex-col gap-s1 empty:hidden">
      {running.map((one) => (
        <div key={one.name} data-preview-line className="flex items-center gap-s2 text-ui text-muted">
          <span className="min-w-0 flex-1 truncate">
            {t("previews.strip", { name: one.name, port: one.port })}
          </span>
          <Button variant="secondary" size="sm" onClick={() => onOpen(targetOf(box, one.name))}>
            {t("previews.open")}
          </Button>
        </div>
      ))}
    </div>
  );
}
