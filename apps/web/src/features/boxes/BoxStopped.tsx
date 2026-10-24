import "../../i18n/register-boxes.ts";
import { EmptyState } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useBoxPhase, useBoxProjectId } from "../../stores/box-phase.ts";
import { BoxStart } from "./BoxStart.tsx";

/**
 * The stopped panel of Files and Changes (DESIGN.md §9.1): the dashed frame, the one sentence, START. Without a box
 * project for `path` (the answer came before the stream did) it still says the sentence, and START waits for the project.
 */
export function BoxStopped({ path }: { readonly path: string }) {
  const t = useT();
  const projectId = useBoxProjectId(path);
  const phase = useBoxPhase(path);
  return (
    <div className="p-s3">
      <EmptyState
        title={t("boxes.stopped.title")}
        purpose={t("boxes.stopped.purpose")}
        action={projectId === null ? null : <BoxStart projectId={projectId} phase={phase ?? "stopped"} />}
      />
    </div>
  );
}
