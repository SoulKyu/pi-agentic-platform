import type { LaneTurn } from "./review-types.ts";
import { Button, cn, FOCUS_RING, Icon, IconChevronDown, IconRefresh, LoadingLine } from "@pap/ui";
import { Menu } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import "./register-review-catalog.ts";
import { turnPreview } from "./review.vm.ts";
import type { TurnsState } from "./use-review-data.ts";

export type ScopeChoice =
  { readonly kind: "branch" } | { readonly kind: "turn"; readonly userEntryId: string | null };

interface ScopeBarProps {
  readonly scope: ScopeChoice;
  readonly turns: TurnsState;
  readonly hasSession: boolean;
  onScope(scope: ScopeChoice): void;
  onRefresh(): void;
}

const TAB =
  "h-control border-b-2 px-s2 label-hud pointer-coarse:min-h-11 pointer-coarse:min-w-11 cursor-pointer";

/** Branch / Turn n (board 10): Turn opens a menu of the session's turns, newest first (M9R88). */
export function ScopeBar({ scope, turns, hasSession, onScope, onRefresh }: ScopeBarProps) {
  const t = useT();
  const turnLabel = (turn: LaneTurn) =>
    t("lanes.review.turn.label", { index: turn.index, preview: turnPreview(turn) });
  const picked =
    scope.kind === "turn" && turns.phase === "ready"
      ? turns.value.find((turn) => turn.userEntryId === scope.userEntryId)
      : undefined;
  let note: string | null = null;
  let loading = false;
  if (scope.kind === "turn") {
    if (!hasSession) note = t("lanes.review.turn.noSession");
    else if (turns.phase === "loading") loading = true;
    else if (turns.phase === "error") note = t("lanes.review.turn.failed");
    else if (turns.value.length === 0) note = t("lanes.review.turn.none");
  }
  return (
    <div className="flex flex-wrap items-center gap-x-s2 border-b border-border px-s3">
      <div
        role="group"
        aria-label={t("lanes.review.scope.label")}
        className="inline-flex items-center gap-s1"
      >
        {(["branch", "turn"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            data-scope={kind}
            aria-pressed={scope.kind === kind}
            onClick={() =>
              kind === "branch" ? onScope({ kind: "branch" }) : onScope({ kind: "turn", userEntryId: null })
            }
            className={cn(
              TAB,
              FOCUS_RING,
              scope.kind === kind
                ? "border-agent text-fg"
                : "border-transparent text-muted can-hover:hover:text-fg",
            )}
          >
            {t(kind === "branch" ? "lanes.review.scope.branch" : "lanes.review.scope.turn")}
          </button>
        ))}
      </div>
      {scope.kind === "turn" && turns.phase === "ready" && turns.value.length > 0 ? (
        <Menu
          label={t("lanes.review.turn.menu")}
          closeLabel={t("lanes.action.close")}
          trigger={
            <Button variant="ghost" size="sm" aria-label={t("lanes.review.turn.menu")}>
              <span className="max-w-48 truncate">
                {picked ? turnLabel(picked) : t("lanes.review.turn.menu")}
              </span>
              <Icon icon={IconChevronDown} size={14} />
            </Button>
          }
          items={turns.value.map((turn) => ({
            id: turn.userEntryId,
            label: turnLabel(turn),
            onSelect: () => onScope({ kind: "turn", userEntryId: turn.userEntryId }),
          }))}
        />
      ) : null}
      {loading ? <LoadingLine label={t("lanes.review.turn.loading")} /> : null}
      {note === null ? null : <span className="text-ui text-muted">{note}</span>}
      <span className="ms-auto">
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <Icon icon={IconRefresh} size={14} />
          {t("lanes.review.refresh")}
        </Button>
      </span>
    </div>
  );
}
