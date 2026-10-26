import "../../i18n/register-boxes.ts";
import { EmptyState } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { agentIdOfPath, useBoxPhase, useBoxProjectId } from "../../stores/box-phase.ts";
import { useIsLaunching } from "../../stores/launch-store.ts";
import { BoxStart } from "./BoxStart.tsx";

/**
 * The stopped panel of Files and Changes (DESIGN.md §9.1): the dashed frame, the one sentence, START. Without a box
 * project for `path` (the answer came before the stream did) it still says the sentence, and START waits for the project.
 * At an agent's path (`/agents/<id>`) it speaks of the agent's VM, whose phase is its launch: `starting` while one runs (R3).
 */
export function BoxStopped({ path, onStarted }: { readonly path: string; readonly onStarted?: () => void }) {
  const t = useT();
  const projectId = useBoxProjectId(path);
  const phase = useBoxPhase(path);
  const agentId = agentIdOfPath(path);
  const launching = useIsLaunching(agentId === null ? null : { kind: "agent", id: agentId });
  if (agentId !== null)
    return (
      <div className="p-s3">
        <EmptyState
          title={t("boxes.stopped.agent.title")}
          purpose={t("boxes.stopped.agent.purpose")}
          action={
            <BoxStart
              box={{ kind: "agent", id: agentId }}
              phase={launching ? "starting" : "stopped"}
              {...(onStarted === undefined ? {} : { onStarted })}
            />
          }
        />
      </div>
    );
  return (
    <div className="p-s3">
      <EmptyState
        title={t("boxes.stopped.title")}
        purpose={t("boxes.stopped.purpose")}
        action={
          projectId === null ? null : (
            <BoxStart box={{ kind: "project", id: projectId }} phase={phase ?? "stopped"} />
          )
        }
      />
    </div>
  );
}
