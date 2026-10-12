import type { SearchHit } from "@pap/contracts";
import { Kbd } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Command } from "cmdk";
import { useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../../../i18n/index.ts";
import "../../../i18n/register-sidebar.ts";
import { useFocusEntry } from "../../../stores/focus-entry.ts";
import { rankItems, type PaletteItem, type RankedItems } from "./rank.ts";
import { resultCountLabel } from "./result-count.ts";
import { TranscriptHits } from "./TranscriptHits.tsx";
import { useTranscriptSearch } from "./transcript-search.ts";

interface CommandPaletteProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly items: readonly PaletteItem[];
  /** Opens a session in the workspace: a transcript hit's row (M4R108). */
  openSession(sessionId: string): void;
}

function RankedGroup({
  entry: { group, items: rows },
  onChoose,
}: {
  entry: RankedItems["groups"][number];
  onChoose(item: PaletteItem): void;
}) {
  const t = useT();
  return (
    <Command.Group heading={t(`commands.palette.group.${group}`)} className="text-label text-muted">
      {rows.map((item) => (
        <Command.Item
          key={item.id}
          value={item.id}
          onSelect={() => onChoose(item)}
          className="flex items-center justify-between gap-s2 rounded-sm px-s2 py-s1 text-ui text-fg aria-selected:bg-surface-2"
        >
          <span className="truncate">{item.title}</span>
          {item.detail ? (
            <span className="min-w-0 flex-1 truncate font-mono text-code text-muted">{item.detail}</span>
          ) : null}
          {item.chord ? <Kbd keys={item.chord} joiner={item.chordJoiner ?? ""} /> : null}
        </Command.Item>
      ))}
    </Command.Group>
  );
}

const SEARCH_ERROR_KEY = { timeout: "search.timeout", capacity: "search.busy" } as const;

/** Only the two codes search can answer have their own line; anything else, whatever its name, is the generic one. */
const searchErrorKey = (code: string | undefined) =>
  code !== undefined && Object.hasOwn(SEARCH_ERROR_KEY, code)
    ? SEARCH_ERROR_KEY[code as keyof typeof SEARCH_ERROR_KEY]
    : "search.failed";

/**
 * Orca's palette on cmdk with its own filter off: `rankItems` orders and counts, cmdk only moves the selection.
 * Loaded on first open (spec C §7.4). No digit chords here: the browser keeps Ctrl/⌘/Alt+1..9 (M3-RT-31).
 */
export default function CommandPalette({ open, onOpenChange, items, openSession }: CommandPaletteProps) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ranked = useMemo(() => rankItems(items, query), [items, query]);
  const search = useTranscriptSearch(query);
  const announced = resultCountLabel(locale, t, ranked.count + search.hits.length);
  const searchLine =
    search.status === "loading"
      ? t("search.loading")
      : search.status === "error"
        ? t(searchErrorKey(search.code))
        : null;
  const choose = (hit: SearchHit) => {
    onOpenChange(false);
    useFocusEntry.getState().ask({ sessionId: hit.sessionId, entryId: hit.entryId });
    openSession(hit.sessionId);
  };
  const run = (item: PaletteItem) => {
    onOpenChange(false);
    item.run();
  };
  const renderGroup = (entry: RankedItems["groups"][number]) => (
    <RankedGroup key={entry.group} entry={entry} onChoose={run} />
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      variant="palette"
      hideTitle
      title={t("commands.palette.dialog")}
      closeLabel={t("ui.close")}
      initialFocus={input}
    >
      <div data-command-palette="">
        <Command shouldFilter={false} loop label={t("commands.palette.dialog")}>
          <Command.Input
            ref={input}
            aria-label={t("commands.palette.input")}
            value={query}
            onValueChange={setQuery}
            className="w-full border-b border-border bg-transparent px-s3 py-s2 text-ui text-fg outline-none"
          />
          <Command.List className="max-h-app overflow-y-auto p-s1">
            {searchLine === null ? (
              <Command.Empty className="px-s3 py-s2 text-ui text-muted">
                {ranked.actionsOnly ? t("commands.palette.emptyActions") : t("commands.palette.empty")}
              </Command.Empty>
            ) : null}
            {ranked.groups.filter((entry) => entry.group !== "settings").map(renderGroup)}
            {search.hits.length > 0 ? (
              <TranscriptHits hits={search.hits} loading={search.status === "loading"} onChoose={choose} />
            ) : null}
            {ranked.groups.filter((entry) => entry.group === "settings").map(renderGroup)}
          </Command.List>
          {searchLine === null ? null : (
            <p role="status" data-search-status="" className="px-s3 py-s2 text-ui text-muted">
              {searchLine}
            </p>
          )}
        </Command>
        <p className="sr-only" aria-live="polite">
          {announced}
        </p>
      </div>
    </Dialog>
  );
}
