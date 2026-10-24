import "../../i18n/register-boxes.ts";
import type { InboxItem, ProjectSummary } from "@pap/contracts";
import { Button, Chip, cn, FOCUS_RING, Icon, IconWork } from "@pap/ui";
import { formatAge } from "../../i18n/age.ts";
import { useT } from "../../i18n/index.ts";
import { visibleName } from "../../lib/visible-name.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import type { InboxRowProps } from "./InboxRow.tsx";

/** Hidden characters (bidi, zero-width, controls) are written out of the text, never drawn. */
const HIDDEN = /\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/gu;

export const BOX_PAUSED = "box_paused";

/** The project an item names: its `refId` when that is a project, else the one box project that has the item's name. */
function projectOf(
  projects: ReadonlyMap<string, ProjectSummary>,
  item: InboxItem,
): ProjectSummary | undefined {
  const byId = item.refId === null ? undefined : projects.get(item.refId);
  if (byId !== undefined) return byId;
  const named = [...projects.values()].filter(
    (project) => project.kind === "box" && project.name === item.triggerName,
  );
  return named.length === 1 ? named[0] : undefined;
}

/**
 * "Project box paused after 3 crashes" (R7): a project item, never an agent row: its title, the project's name, the
 * daemon's fixed detail line, and a link to the project page when the project is still listed.
 */
export function BoxPausedRow({ item, now, onPick, onOpenProject }: InboxRowProps) {
  const t = useT();
  const projects = useShellStore((state) => state.view.projects);
  const project = projectOf(projects, item);
  const name = visibleName(project?.name ?? item.triggerName);
  const unread = item.readAt === null;
  const detail = item.detail?.replace(HIDDEN, "") ?? "";
  return (
    <li className="border-b border-border last:border-b-0">
      <div className="border-l-2 border-l-transparent">
        <button
          type="button"
          data-slot="inbox-row"
          data-item-id={item.id}
          data-unread={unread ? "true" : undefined}
          onClick={() => onPick(item)}
          className={cn(
            "flex w-full items-start gap-s2 px-s3 py-s2 text-left pointer-coarse:min-h-11",
            FOCUS_RING,
          )}
        >
          <span aria-hidden className="mt-s1 text-muted">
            <Icon icon={IconWork} size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-s1">
            <span className={cn("break-words text-ui", unread ? "font-semibold text-fg" : "text-muted")}>
              {t("boxes.inbox.title")}
            </span>
            <span data-row-project="" className="break-words font-mono text-code text-fg">
              {name}
            </span>
            {detail === "" ? null : <span className="break-words text-ui text-muted">{detail}</span>}
            <span className="flex flex-wrap items-center gap-s2">
              <Chip tone="att" label={t("boxes.inbox.chip")} />
              <span className="font-mono text-label text-muted tabular-nums">
                {formatAge(now, item.createdAt, t)}
              </span>
              {unread ? <span className="sr-only">{t("inbox.unread")}</span> : null}
            </span>
          </span>
        </button>
        {project === undefined || onOpenProject === undefined ? null : (
          <div className="px-s3 pb-s2">
            <Button size="sm" onClick={() => onOpenProject(project.id)}>
              {t("boxes.inbox.open", { name })}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
