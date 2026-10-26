import "../../i18n/register-knowledge.ts";
import "../../i18n/register-boxes.ts";
import { Button, InlineError } from "@pap/ui";
import { useEffect, useState } from "react";
import { t as translate, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { phaseOf } from "../../stores/box-phase.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { BoxStart } from "../boxes/BoxStart.tsx";
import { failureCode, failureText } from "../sessions/failure.ts";
import { useAction } from "../sessions/use-action.ts";
import { useKnowledgeStore } from "./knowledge-store.ts";

const MARK = "\u0001";
const FOLDER = "knowledge/";

/** A catalog sentence with `{folder}` drawn as inline code: the sentence stays one string per language. */
function withFolder(sentence: string) {
  const [before = "", after = ""] = sentence.split(MARK);
  return (
    <>
      {before}
      <code className="font-mono">{FOLDER}</code>
      {after}
    </>
  );
}

/** What happened, what is intact, what to do (error pattern); a code that is not about the folder keeps the house text. */
function enableFailure(failure: unknown): string {
  const code = failureCode(failure);
  if (code === "conflict") return translate("knowledge.row.refused");
  if (code === "internal" || code === "not_found") return translate("knowledge.row.unwritable");
  return failureText(failure);
}

/** The project page's knowledge line: what OKF is for and ENABLE OKF, or how many concepts the bundle holds. */
export function KnowledgeRow({ projectId }: { readonly projectId: string }) {
  const t = useT();
  const version = useKnowledgeStore((state) => state.versions[projectId] ?? 0);
  // Read once: leaving the page clears it, and a development remount must not lose it.
  const [origin] = useState(() => useKnowledgeStore.getState().origin[projectId]);
  const sessionId = origin?.sessionId;
  const [fact, setFact] = useState<{ readonly enabled: boolean; readonly concepts: number } | null>(null);
  const enable = useAction(undefined, undefined, enableFailure);
  // A box project: its knowledge is the box's, so a stopped box answers `box_stopped` and the row reads again once it runs (R3).
  const phase = useShellStore((state) => {
    const project = state.view.projects.get(projectId);
    return project?.kind === "box" ? phaseOf(project) : null;
  });
  const [stopped, setStopped] = useState(false);

  useEffect(() => () => useKnowledgeStore.getState().clearOrigin(projectId), [projectId]);

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("projects.knowledge", sessionId === undefined ? { projectId } : { projectId, sessionId })
      .then(
        (answer) => {
          if (!current || typeof answer.enabled !== "boolean") return;
          setStopped(false);
          setFact(answer);
        },
        (failure: unknown) => {
          if (current && failureCode(failure) === "box_stopped") setStopped(true);
        },
      );
    return () => {
      current = false;
    };
  }, [projectId, sessionId, version, phase]);

  if (stopped && phase !== null) {
    return (
      <div data-knowledge-row="" className="flex flex-wrap items-center gap-s3 text-ui text-muted">
        <p>{t("boxes.stopped.purpose")}</p>
        <BoxStart box={{ kind: "project", id: projectId }} phase={phase} size="sm" variant="secondary" />
      </div>
    );
  }
  if (fact === null) return null;
  const onEnable = () => {
    const runtime = getRuntime();
    void enable
      .run(() =>
        runtime.rpc.call(
          "projects.enableKnowledge",
          sessionId === undefined ? { projectId } : { projectId, sessionId },
          { commandId: runtime.rpc.newCommandId() },
        ),
      )
      .then((done) => {
        if (!done) return;
        // The session's worker started before the knowledge existed: its chip says so until its next start.
        if (origin?.live) useKnowledgeStore.getState().markPending(origin.sessionId);
        useKnowledgeStore.getState().bump(projectId);
      });
  };
  return (
    <div data-knowledge-row="" className="flex flex-wrap items-center gap-s3 text-ui text-muted">
      {fact.enabled ? (
        <p className="tabular-nums">
          {withFolder(t("knowledge.row.present", { count: fact.concepts, folder: MARK }))}
        </p>
      ) : (
        <>
          <p>{withFolder(t("knowledge.row.absent", { folder: MARK }))}</p>
          <Button variant="secondary" disabled={enable.busy} onClick={onEnable}>
            {t("knowledge.row.enable")}
          </Button>
        </>
      )}
      {origin?.lane ? <p className="w-full">{t("knowledge.row.lane")}</p> : null}
      {enable.error === null ? null : (
        <div className="w-full">
          <InlineError announce="action">{enable.error}</InlineError>
        </div>
      )}
    </div>
  );
}
