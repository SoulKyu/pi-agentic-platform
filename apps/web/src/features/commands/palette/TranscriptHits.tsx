import type { SearchHit } from "@pap/contracts";
import { Command } from "cmdk";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { sessionLabel } from "../../../lib/session-label.ts";
import { formatAge } from "../../../i18n/age.ts";
import { snippetParts } from "./snippet.ts";

const ROW_CLASSES =
  "flex flex-col gap-s1 rounded-sm px-s2 py-s1 text-ui text-fg aria-selected:bg-surface-2 data-disabled:opacity-50";

/** The row value of a hit: unique, since the daemon sends one hit per session. */
export const hitValue = (hit: SearchHit): string => `hit:${hit.sessionId}:${hit.entryId}`;

/** The transcript hits (M4R107): the daemon's order, one row per session, each match marked, never as HTML. */
export function TranscriptHits({
  hits,
  loading,
  onChoose,
}: {
  hits: readonly SearchHit[];
  /** A newer query is on its way: these rows belong to the old one and cannot be chosen. */
  loading: boolean;
  onChoose(hit: SearchHit): void;
}) {
  const t = useT();
  const [now] = useState(() => Date.now());
  return (
    <Command.Group heading={t("search.group")} className="text-label text-muted">
      {hits.map((hit) => (
        <Command.Item
          key={`${hit.sessionId}:${hit.entryId}`}
          value={hitValue(hit)}
          disabled={loading}
          onSelect={() => onChoose(hit)}
          className={ROW_CLASSES}
        >
          <span className="truncate">
            {snippetParts(hit.snippet).map((part, index) =>
              part.hit ? (
                <mark key={index} className="rounded-sm bg-you-tint text-you-text">
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </span>
          <span className="font-mono text-code text-muted truncate">
            {t("search.detail", {
              label: sessionLabel(hit.session) || t("shell.tab.session"),
              age: formatAge(now, hit.at, t),
            })}
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
