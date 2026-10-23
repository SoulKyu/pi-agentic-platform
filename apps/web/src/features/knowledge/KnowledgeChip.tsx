import "../../i18n/register-knowledge.ts";
import { Chip, Tooltip } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useWorkspaceStore } from "../workspace/index.ts";
import { useKnowledgeStore } from "./knowledge-store.ts";

/**
 * Whether this project session has OKF knowledge: `OKF` when it does, a link to the project page ("NO OKF") when it
 * does not. After an enable in this browser the chip says it applies from the session's next start (the worker already
 * running keeps its prompt) until the worker stops and starts again.
 */
export function KnowledgeChip({
  projectId,
  sessionId,
  status,
  cwd,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  /** The session's worker status: a `cold` one followed by any other is a new start. */
  readonly status: string;
  /** Its folder: outside the project's root it is a lane's worktree. */
  readonly cwd?: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const version = useKnowledgeStore((state) => state.versions[projectId] ?? 0);
  const pending = useKnowledgeStore((state) => state.pending[sessionId] === true);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const lastEnabled = useRef<boolean | null>(null);
  const coldSeen = useRef(false);

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("projects.knowledge", { projectId, sessionId })
      .then(
        (answer) => {
          if (!current || typeof answer.enabled !== "boolean") return;
          if (lastEnabled.current === false && answer.enabled) {
            useKnowledgeStore.getState().markPending(sessionId);
          }
          lastEnabled.current = answer.enabled;
          setEnabled(answer.enabled);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [projectId, sessionId, version]);

  useEffect(() => {
    if (status === "cold") coldSeen.current = true;
    else {
      if (coldSeen.current) useKnowledgeStore.getState().clearPending(sessionId);
      coldSeen.current = false;
    }
  }, [status, sessionId]);

  if (enabled === null) return null;
  if (enabled) {
    const word = t("knowledge.chip.on");
    return pending ? (
      <Tooltip label={t("knowledge.chip.pending")}>
        <span role="img" aria-label={t("knowledge.chip.pending")}>
          <Chip tone="ok" label={word} />
        </span>
      </Tooltip>
    ) : (
      <Chip tone="ok" label={word} />
    );
  }
  const openProject = () => {
    // The project page reads and enables this session's folder, and the label survives this screen unmounting.
    const root = useShellStore.getState().view.projects.get(projectId)?.root;
    const lane = cwd !== undefined && root !== undefined && cwd !== root && !cwd.startsWith(`${root}/`);
    useKnowledgeStore.getState().setOrigin(projectId, { sessionId, live: status !== "cold", lane });
    useCurrentProject.getState().choose(projectId);
    useWorkspaceStore.getState().open({ kind: "home" });
    void navigate({ to: "/" }).catch(() => reportClientIssue("command_failed"));
  };
  return (
    <Tooltip label={t("knowledge.chip.enable")}>
      <button
        type="button"
        data-knowledge-link=""
        aria-label={t("knowledge.chip.enable")}
        onClick={openProject}
        className="cursor-pointer rounded-sm focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <Chip tone="mut" label={t("knowledge.chip.off")} />
      </button>
    </Tooltip>
  );
}
