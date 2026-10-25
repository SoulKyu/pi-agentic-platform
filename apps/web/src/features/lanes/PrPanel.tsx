import "./register-lane-commit-catalog.ts";
import { LANE_LIMITS, type LaneView } from "@pap/contracts";
import { Button, Checkbox, Chip, TextField, InlineError } from "@pap/ui";
import { escapeHiddenKeepLines } from "../../lib/escape-hidden.ts";
import { useT } from "../../i18n/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { pushModel } from "./commit-bar.vm.ts";
import { CheckCount } from "./CheckCount.tsx";
import { PrError } from "./PrError.tsx";
import { prBadge } from "./lane-header.vm.ts";
import { FORGE_NAME, forgeNotice, openUrl, PR_REFUSED, PR_TITLE_MAX } from "./pr.vm.ts";
import { usePrPanel } from "./use-pr-panel.ts";

/**
 * The pull request of a lane (M9R92): a form while there is none, the badge's details once there is one. Everything
 * the forge sent is shown as text; the address opens only when it is https.
 */
export function PrPanel({ laneId }: { readonly laneId: string }) {
  const lane = useLaneStore((state) => state.view.lanes.get(laneId));
  if (!lane) return null;
  return <Panel lane={lane} />;
}

function Panel({ lane }: { readonly lane: LaneView }) {
  const t = useT();
  const panel = usePrPanel(lane);
  const { target } = pushModel(lane);
  const busy = panel.since !== null || panel.busyElsewhere;
  const pending = (action: typeof panel.active) => (panel.active === action ? panel.since : null);
  const forge = lane.forge === null ? t("laneCommit.pr.forge.other") : t(FORGE_NAME[lane.forge]);
  const badge = panel.pr === null ? null : prBadge(panel.pr);
  const notice = forgeNotice(lane, panel.refusal ?? panel.pr?.error ?? null);
  const messages = (
    <>
      {panel.refusal !== null && panel.refusal !== "not_pushed" ? (
        <InlineError announce="action">{t(PR_REFUSED[panel.refusal])}</InlineError>
      ) : null}
      {panel.refusal === "not_pushed" ? (
        <p className="text-ui text-muted">{t(PR_REFUSED.not_pushed)}</p>
      ) : null}
      {panel.problem !== null ? <InlineError announce="action">{t(panel.problem)}</InlineError> : null}
      {panel.checkedNone ? <p className="text-ui text-muted">{t("laneCommit.pr.checkNone")}</p> : null}
      {notice !== null ? <p className="text-ui text-muted">{t(notice)}</p> : null}
    </>
  );

  if (badge !== null && panel.pr !== null) {
    const href = openUrl(panel.pr.url);
    return (
      <section data-slot="lane-pr-panel" className="flex flex-col gap-s2">
        <div className="flex flex-wrap items-center gap-s2 font-mono text-code tabular-nums text-muted">
          <span className="text-fg">{`#${badge.number}`}</span>
          {badge.state !== null ? <Chip tone="mut" label={t(badge.state)} /> : null}
          {badge.checks.map((check) => (
            <CheckCount key={check.kind} kind={check.kind} count={check.count} />
          ))}
          {badge.conflicts ? <span className="text-attn">{t("lanes.pr.conflicts")}</span> : null}
          {badge.error !== null ? <PrError message={badge.error} /> : null}
        </div>
        {messages}
        <div className="flex flex-wrap items-center gap-s2">
          <Button size="sm" pendingSince={pending("refresh")} disabled={busy} onClick={panel.refresh}>
            {badge.error !== null ? t("lanes.pr.retry") : t("laneCommit.pr.refresh")}
          </Button>
          <Button
            size="sm"
            disabled={href === null}
            onClick={() => {
              if (href !== null) window.open(href, "_blank", "noopener,noreferrer");
            }}
          >
            {t("laneCommit.pr.openOn", { forge })}
          </Button>
        </div>
      </section>
    );
  }

  const showPreview = panel.form.body.trim() === "" && lane.descriptionPreview !== "";
  const supported = lane.forge !== "gitlab" && lane.forge !== "gitea";
  return (
    <section data-slot="lane-pr-panel" className="flex flex-col gap-s2">
      {supported && !panel.unknown ? (
        <>
          <TextField
            label={t("laneCommit.pr.title")}
            value={panel.form.title}
            onChange={(title) => panel.edit({ title: title.slice(0, PR_TITLE_MAX) })}
            ground="surface"
            disabled={busy}
          />
          <TextField
            label={t("laneCommit.pr.body")}
            hint={t(
              lane.createdBy === "token" && showPreview
                ? "laneCommit.pr.bodyHint.token"
                : "laneCommit.pr.bodyHint",
            )}
            value={panel.form.body}
            onChange={(body) => panel.edit({ body })}
            multiline
            rows={3}
            ground="surface"
            disabled={busy}
          />
          {showPreview ? (
            <div className="flex flex-col gap-s1">
              <pre
                data-slot="lane-pr-body-preview"
                className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-muted"
              >
                {escapeHiddenKeepLines(lane.descriptionPreview)}
              </pre>
              {lane.descriptionTruncated ? (
                <p className="text-ui text-muted">
                  {t("laneCommit.pr.bodyClipped", { count: LANE_LIMITS.descriptionPreview })}
                </p>
              ) : null}
            </div>
          ) : null}
          <Checkbox
            label={t("laneCommit.pr.draft")}
            checked={panel.form.draft}
            disabled={busy}
            onChange={(draft) => panel.edit({ draft })}
          />
        </>
      ) : null}
      {panel.unknown ? <InlineError announce="action">{t("laneCommit.pr.unknown")}</InlineError> : null}
      {messages}
      <div className="flex flex-wrap items-center gap-s2">
        {panel.unknown ? (
          <Button
            size="sm"
            variant="primary"
            pendingSince={pending("refresh")}
            disabled={busy}
            onClick={panel.refresh}
          >
            {t("laneCommit.pr.check")}
          </Button>
        ) : null}
        {supported && !panel.unknown && panel.refusal === "not_pushed" ? (
          <Button
            size="sm"
            variant="primary"
            pendingSince={pending("pushCreate")}
            stageLabel={t("laneCommit.pr.pushAndCreate.stage")}
            disabled={busy || panel.form.title.trim() === ""}
            onClick={panel.pushAndCreate}
          >
            {target === null
              ? t("laneCommit.pr.pushAndCreate")
              : t("laneCommit.pr.pushAndCreate.to", { target })}
          </Button>
        ) : null}
        {supported && !panel.unknown && panel.refusal !== "not_pushed" ? (
          <Button
            size="sm"
            variant="primary"
            pendingSince={pending("create")}
            stageLabel={t("laneCommit.pr.create.stage")}
            disabled={busy || panel.form.title.trim() === ""}
            onClick={panel.create}
          >
            {t("laneCommit.pr.create")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
