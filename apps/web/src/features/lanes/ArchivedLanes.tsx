import "./register-lanes-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useLocale, useT } from "../../i18n/index.ts";
import { useArchivedLanes } from "./archived.vm.ts";

/** The pull request is a link only when its address is http(s): a forge's answer is not trusted to be a link. */
const linkable = (url: string): boolean => /^https?:\/\//.test(url);

function Row({ lane }: { readonly lane: LaneView }) {
  const t = useT();
  const locale = useLocale();
  const date =
    lane.archivedAt === null
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(lane.archivedAt));
  return (
    <li data-archived-lane={lane.id} className="flex flex-col gap-s1 border-b border-border py-s2">
      <span className="min-w-0 truncate text-ui font-semibold text-fg">{lane.title || lane.branch}</span>
      <span className="min-w-0 truncate font-mono text-code text-muted">{lane.branch}</span>
      <span className="flex flex-wrap items-center gap-s2 text-ui text-muted">
        {lane.pr !== null ? (
          linkable(lane.pr.url) ? (
            <a
              href={lane.pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-you-text underline focus-ring"
            >
              {t("lanes.archived.pr", { number: lane.pr.number })}
            </a>
          ) : (
            <span>{t("lanes.archived.pr", { number: lane.pr.number })}</span>
          )
        ) : null}
        {date !== null ? <span>{t("lanes.archived.on", { date })}</span> : null}
      </span>
    </li>
  );
}

/**
 * The archived lanes (M9R121), a lazy list inside the tree's "Archived lanes (n)" entry. Rows are read-only: the
 * worktree is gone, pap keeps title, branch, pull request and date.
 */
export default function ArchivedLanes({ count }: { readonly count: number; onPick?(id: string): void }) {
  const t = useT();
  const list = useArchivedLanes(count > 0);
  return (
    <div className="flex flex-col gap-s2">
      {list.lanes.length === 0 && !list.loading && !list.failed ? (
        <p className="text-ui text-muted">{t("lanes.archived.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {list.lanes.map((lane) => (
            <Row key={lane.id} lane={lane} />
          ))}
        </ul>
      )}
      {list.failed ? (
        <div className="flex flex-col items-start gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("lanes.archived.failed")}
          </p>
          <Button onClick={list.more}>{t("lanes.archived.retry")}</Button>
        </div>
      ) : list.hasMore && list.lanes.length > 0 ? (
        <div>
          <Button disabled={list.loading} onClick={list.more}>
            {t("lanes.archived.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
