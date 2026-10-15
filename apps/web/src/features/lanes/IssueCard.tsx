import type { IssueView } from "@pap/contracts";
import { Fence } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { parseIssueUrl } from "./issue-url.ts";

/**
 * A fetched issue: external content, so the dashed attention frame with `UNTRUSTED · <forge> issue` (DESIGN §2,
 * decision 29). Every field is rendered as text; the body is cut to three lines.
 */
export function IssueCard({ issue }: { readonly issue: IssueView }) {
  const t = useT();
  const repo = parseIssueUrl(issue.url)?.path ?? "";
  return (
    <Fence label={t("laneNew.issue.fence", { forge: issue.forge })}>
      <div className="flex flex-col gap-s1">
        <p className="font-sans text-ui font-semibold text-fg">{issue.title}</p>
        <p>{t("laneNew.issue.meta", { repo, number: issue.number, state: issue.state })}</p>
        {issue.labels.length > 0 ? (
          <p>{t("laneNew.issue.labels", { labels: issue.labels.join(", ") })}</p>
        ) : null}
        <p data-issue-body className="line-clamp-3 whitespace-pre-wrap break-words">
          {issue.body}
        </p>
        {issue.truncated ? <p>{t("laneNew.issue.truncated")}</p> : null}
      </div>
    </Fence>
  );
}
