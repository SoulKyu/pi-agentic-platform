import "./register-lane-commit-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { MAX_COMMIT_PATHS } from "./commit-bar.vm.ts";
import { FileChecklist } from "./FileChecklist.tsx";
import { PrPanel } from "./PrPanel.tsx";
import { useCommitBar } from "./use-commit-bar.ts";

/**
 * The lane's commit bar (board 10 §1, M9R91), under the review: a mono message, ✦ Suggest, Commit, and Push ↑n → target.
 * `worktree` is the folder whose changes the bar watches (the `vcs` stream); the lane itself comes from the lane store.
 */
export function CommitBar({ laneId, worktree }: { readonly laneId: string; readonly worktree: string }) {
  const lane = useLaneStore((state) => state.view.lanes.get(laneId));
  if (!lane || lane.state !== "active") return null;
  return <Bar lane={lane} worktree={worktree} />;
}

function Bar({ lane, worktree }: { readonly lane: LaneView; readonly worktree: string }) {
  const t = useT();
  const locale = useLocale();
  const bar = useCommitBar(lane, worktree);
  const [listOpen, setListOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const busy = bar.since !== null;
  const pending = (action: typeof bar.active) => (bar.active === action ? bar.since : null);
  const count = bar.files.length;

  return (
    <section
      data-slot="lane-commit-bar"
      aria-label={t("laneCommit.region")}
      className="flex flex-col gap-s2 border-t border-border bg-surface px-s3 py-s2"
    >
      {prOpen ? <PrPanel laneId={lane.id} /> : null}
      {listOpen ? (
        <FileChecklist
          files={bar.files}
          unticked={bar.unticked}
          disabled={busy}
          truncated={bar.truncated}
          onToggle={bar.toggle}
          onTickAll={bar.tickAll}
        />
      ) : null}
      <TextField
        label={t("laneCommit.message")}
        value={bar.message}
        onChange={bar.edit}
        multiline
        mono
        rows={2}
        ground="surface"
        disabled={busy}
        placeholder={t("laneCommit.message.placeholder")}
        onSubmitShortcut={bar.commit}
      />
      {bar.suggestion !== null ? (
        <div role="status" className="flex flex-col gap-s2 border-l-2 border-you-line pl-s2">
          <p className="text-ui text-fg">{t("laneCommit.suggest.replace")}</p>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-muted">
            {bar.suggestion}
          </pre>
          <div className="flex gap-s2">
            <Button size="sm" variant="primary" onClick={bar.acceptSuggestion}>
              {t("laneCommit.suggest.replaceYes")}
            </Button>
            <Button size="sm" onClick={bar.keepMessage}>
              {t("laneCommit.suggest.replaceNo")}
            </Button>
          </div>
        </div>
      ) : null}
      {bar.problem !== null ? (
        <p role="alert" className="text-ui text-attn">
          {t(bar.problem)}
        </p>
      ) : null}
      {bar.tooMany ? (
        <p role="alert" className="text-ui text-attn">
          {t("laneCommit.files.tooMany", { max: MAX_COMMIT_PATHS })}
        </p>
      ) : null}
      {bar.push.whyNot !== null ? <p className="text-ui text-muted">{t(bar.push.whyNot)}</p> : null}
      {bar.note !== null ? (
        <p role="status" className="text-ui text-muted">
          {t(bar.note.key, bar.note.vars)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-s2">
        {bar.known ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
          >
            {plural(locale, "laneCommit.files", count, { n: bar.ticked })}
          </Button>
        ) : (
          <span className="text-ui text-muted">
            {t(bar.watchFailed ? "laneCommit.files.failed" : "laneCommit.files.loading")}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-s2">
          <Button
            size="sm"
            pendingSince={pending("suggest")}
            stageLabel={t("laneCommit.suggest.stage")}
            disabled={!bar.canSuggest}
            onClick={bar.suggest}
          >
            {t("laneCommit.suggest")}
          </Button>
          <Button
            size="sm"
            pendingSince={pending("commit")}
            stageLabel={t("laneCommit.commit.stage")}
            disabled={!bar.canCommit}
            onClick={bar.commit}
          >
            {t("laneCommit.commit")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            pendingSince={pending("push")}
            stageLabel={t("laneCommit.push.stage")}
            disabled={!bar.canPush}
            onClick={bar.doPush}
          >
            {t(bar.push.label.key, bar.push.label.vars)}
          </Button>
          <Button size="sm" variant="ghost" aria-expanded={prOpen} onClick={() => setPrOpen((open) => !open)}>
            {lane.pr === null
              ? t("laneCommit.pr.toggle")
              : t("laneCommit.pr.toggleNumber", { number: lane.pr.number })}
          </Button>
        </span>
      </div>
    </section>
  );
}
