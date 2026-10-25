import "./register-lane-new-catalog.ts";
import type { ModelPick, ProjectSummary, ResultOf } from "@pap/contracts";
import { Button, Select, TextField, useIsPhone, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useEffect, useRef, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { failureKey } from "./failure-text.ts";
import { IssueCard } from "./IssueCard.tsx";
import { parseIssueUrl } from "./issue-url.ts";
import { ModelSlots } from "./ModelSlots.tsx";
import {
  addSlot,
  baseOptions,
  branchProblem,
  canCreate,
  createParams,
  emptyDraft,
  isForeignBase,
  prefillDraft,
  removeSlot,
  setModel,
  withBase,
  withBranch,
  withIssue,
  withText,
  withTitle,
} from "./new-lane.vm.ts";
import { ScriptTrust } from "./ScriptTrust.tsx";
import { useLanePreview } from "./use-new-lane-data.ts";

export type Created = ResultOf<"lanes.create">;

interface Props {
  readonly projects: readonly ProjectSummary[];
  /** The project the dialog opens for; null asks the person to pick one. */
  readonly initialProjectId: string | null;
  /** "Run again" and the home: the prompt or issue link, the models, and the home's title. */
  readonly prefill?: {
    readonly text: string;
    readonly models: ReadonlyArray<ModelPick | null>;
    readonly title?: string;
  } | null;
  onClose(): void;
  /** The new lane ids (and the fan-out group): the caller opens the lane tab, or the compare tab. */
  onCreated(created: Created): void;
}

const CREATE_ERRORS: Readonly<Record<string, MessageKey>> = {
  not_found: "laneNew.error.not_found",
  bad_request: "laneNew.error.bad_request",
  conflict: "laneNew.error.conflict",
  limit_reached: "laneNew.error.limit_reached",
  capacity: "laneNew.error.capacity",
  read_only: "laneNew.error.read_only",
};
const createFailure = (failure: unknown): MessageKey => {
  const key = failureKey(failure, "laneNew.previewFailed");
  const code = key.startsWith("error.") ? key.slice("error.".length) : "";
  return CREATE_ERRORS[code] ?? key;
};

/**
 * ⌘⇧L: title and description (or an issue), branch and base, a model per lane (fan-out up to four) and the approval of
 * the project's scripts (board 10 §3, M9R93-M9R95). Mounted only while open; Radix traps focus and returns it.
 */
export function NewLaneDialog({ projects, initialProjectId, prefill, onClose, onCreated }: Props) {
  const t = useT();
  const phone = useIsPhone();
  const stepUp = useStepUpRunner();
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const root = projects.find((project) => project.id === projectId)?.root ?? null;
  const { preview, error, reload } = useLanePreview(root);
  const [draft, setDraft] = useState(() =>
    prefill ? prefillDraft(prefill.text, prefill.models, prefill.title) : emptyDraft(),
  );
  const [fetching, setFetching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [issueProblem, setIssueProblem] = useState<MessageKey | null>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const prefix = preview?.config.branchPrefix ?? "pi/";
  const busy = fetching || creating || approving;
  const shown = preview !== null && preview.repo;
  // The form appears once the project is read: the first focus moves to the description unless the person already went elsewhere.
  useEffect(() => {
    const active = document.activeElement;
    if (shown && (active === document.body || active?.getAttribute("data-slot") === "dialog"))
      source.current?.focus();
  }, [shown]);
  const link = parseIssueUrl(draft.text, preview?.forge ?? undefined);
  const unapproved = preview?.config.scripts.filter((script) => !script.approved) ?? [];
  const ready = preview !== null && preview.repo && canCreate(draft) && !busy;

  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const fetchIssue = () => {
    if (root === null || busy) return;
    setFetching(true);
    setIssueProblem(null);
    getRuntime()
      .rpc.call("lanes.issue", { projectRoot: root, url: draft.text.trim() })
      .then(
        (answer) => {
          setFetching(false);
          if (answer.ok) setDraft((current) => withIssue(current, answer.issue, prefix));
          else setIssueProblem(`laneNew.issue.${answer.reason}`);
        },
        (failure: unknown) => {
          setFetching(false);
          setIssueProblem(failureKey(failure, "laneNew.issue.failed"));
        },
      );
  };

  const approve = () => {
    if (root === null || busy || unapproved.length === 0) return;
    const scripts = unapproved.map((script) => ({ kind: script.kind, sha256: script.sha256 }));
    setApproving(true);
    setProblem(null);
    stepUp((commandId) =>
      getRuntime().rpc.call("lanes.approveScripts", { projectRoot: root, scripts }, { commandId }),
    ).then(
      (answer) => {
        setApproving(false);
        if (answer === null) return;
        if (!answer.ok) setProblem("laneNew.script.changedWhileReading");
        reload();
      },
      (failure: unknown) => {
        setApproving(false);
        setProblem(failureKey(failure, "laneNew.script.failed"));
      },
    );
  };

  const create = () => {
    if (root === null || !ready) return;
    setCreating(true);
    setProblem(null);
    const { rpc } = getRuntime();
    rpc.call("lanes.create", createParams(draft, root), { commandId: rpc.newCommandId() }).then(
      (created) => {
        setCreating(false);
        onCreated(created);
        onClose();
      },
      (failure: unknown) => {
        setCreating(false);
        setProblem(createFailure(failure));
      },
    );
  };

  const columns = phone ? "grid grid-cols-1 gap-s3" : "grid grid-cols-2 gap-s3";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creating) onClose();
      }}
      title={t("laneNew.title")}
      description={t("laneNew.description")}
      closeLabel={t("lanes.action.close")}
      initialFocus={source}
      footer={
        <Fragment>
          <span className="mr-auto self-center text-ui text-muted">{t("laneNew.note")}</span>
          <Button disabled={creating} onClick={onClose}>
            {t("laneNew.cancel")}
          </Button>
          {unapproved.length > 0 ? (
            <Button disabled={busy} onClick={approve}>
              {t(approving ? "laneNew.script.approving" : "laneNew.script.approve")}
            </Button>
          ) : null}
          <Button variant="primary" disabled={!ready} onClick={create}>
            {t(creating ? "laneNew.creating" : "laneNew.create")}
          </Button>
        </Fragment>
      }
    >
      <div data-slot="new-lane" className="flex flex-col gap-s3 p-s3">
        {projects.length > 1 ? (
          <Select
            label={t("laneNew.project")}
            value={projectId}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            disabled={busy}
            onChange={(value) => {
              setProjectId(value);
              setDraft(emptyDraft());
              setIssueProblem(null);
              setProblem(null);
            }}
          />
        ) : null}
        {preview === null ? (
          error === null ? (
            <p className="text-ui text-muted">{t("laneNew.loading")}</p>
          ) : (
            <InlineError announce="background">{t(error)}</InlineError>
          )
        ) : !preview.repo ? (
          <InlineError announce="background">{t("laneNew.noRepo")}</InlineError>
        ) : (
          <>
            <TextField
              label={t("laneNew.source")}
              hint={t("laneNew.source.hint")}
              error={issueProblem === null ? null : t(issueProblem)}
              multiline
              rows={4}
              inputRef={source}
              value={draft.text}
              disabled={creating}
              onChange={(text) => {
                setIssueProblem(null);
                setDraft((current) => withText(current, text, prefix));
              }}
              onSubmitShortcut={create}
            />
            {link !== null && draft.issue === null ? (
              <div>
                <Button disabled={busy} onClick={fetchIssue}>
                  {t(fetching ? "laneNew.fetching" : "laneNew.fetch")}
                </Button>
              </div>
            ) : null}
            {draft.issue !== null ? <IssueCard issue={draft.issue} /> : null}
            <TextField
              label={t("laneNew.titleField")}
              value={draft.title}
              disabled={creating}
              onChange={(title) => setDraft((current) => withTitle(current, title, prefix))}
            />
            <div className={columns}>
              <TextField
                label={t("laneNew.branch")}
                value={draft.branch}
                disabled={creating}
                error={branchProblem(draft.branch) ? t("laneNew.branch.invalid") : null}
                onChange={(branch) => setDraft((current) => withBranch(current, branch))}
              />
              <Select
                label={t("laneNew.from")}
                value={draft.base}
                options={baseOptions(
                  preview,
                  preview.current === null
                    ? t("laneNew.from.detached")
                    : t("laneNew.from.current", { branch: preview.current }),
                )}
                disabled={creating}
                onChange={(base) => setDraft((current) => withBase(current, base))}
                {...(isForeignBase(draft.base, preview) ? { hint: t("laneNew.from.foreign") } : {})}
              />
            </div>
            <ModelSlots
              slots={draft.slots}
              cwd={root}
              disabled={creating}
              onModel={(key, model) => setDraft((current) => setModel(current, key, model))}
              onAdd={() => setDraft(addSlot)}
              onRemove={(key) => setDraft((current) => removeSlot(current, key))}
            />
            {unapproved.map((script) => (
              <ScriptTrust key={script.kind} script={script} />
            ))}
            {unapproved.length > 0 ? (
              <p className="text-ui text-muted">{t("laneNew.script.notApproved")}</p>
            ) : null}
          </>
        )}
        {problem !== null ? <InlineError announce="action">{t(problem)}</InlineError> : null}
      </div>
    </Dialog>
  );
}
