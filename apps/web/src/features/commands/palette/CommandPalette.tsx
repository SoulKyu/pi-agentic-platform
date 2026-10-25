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
import { hitValue, TranscriptHits } from "./TranscriptHits.tsx";
import { searchText, useTranscriptSearch } from "./transcript-search.ts";

interface CommandPaletteProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly items: readonly PaletteItem[];
  /** Opens a session in the workspace: a transcript hit's row (M4R108). */
  openSession(sessionId: string): void;
  /** Transcript search only (the home's Search, §3.2): no command or item rows, hits of this project when one is named. */
  readonly search?: { readonly projectId: string | null; readonly projectName: string | null } | null;
}

/** Settings and Actions come after the transcript hits: Lanes, Sessions, Tasks and triggers, hits, then Actions (agreement 21). */
const AFTER_HITS: ReadonlySet<PaletteItem["group"]> = new Set(["settings", "actions"]);

/** The highlighted row: raised surface and the agent rule (board 12). */
const ROW_CLASSES =
  "flex items-center justify-between gap-s2 border-l-2 border-transparent px-s2 py-s1 text-ui text-fg aria-selected:border-agent aria-selected:bg-surface-2";

function RankedGroup({
  entry: { group, items: rows },
  current,
  onChoose,
}: {
  entry: RankedItems["groups"][number];
  /** The value cmdk has highlighted. */
  current: string;
  onChoose(item: PaletteItem): void;
}) {
  const t = useT();
  return (
    <Command.Group
      heading={<span className="label-hud text-muted">{t(`commands.palette.group.${group}`)}</span>}
    >
      {rows.map((item) => (
        <Command.Item
          key={item.id}
          value={item.id}
          onSelect={() => onChoose(item)}
          aria-current={current === item.id ? "true" : undefined}
          className={ROW_CLASSES}
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
export default function CommandPalette({
  open,
  onOpenChange,
  items,
  openSession,
  search,
}: CommandPaletteProps) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const scope = search ?? null;
  const inputLabel =
    scope === null
      ? t("commands.palette.input")
      : scope.projectName === null
        ? t("search.mode.input")
        : t("search.mode.inputIn", { project: scope.projectName });
  const ranked = useMemo(() => rankItems(scope === null ? items : [], query), [items, query, scope]);
  const found = useTranscriptSearch(query);
  // The daemon's search has no project filter (PH8): the hits it answers are narrowed here.
  const narrowTo = scope === null ? null : scope.projectId;
  const hits =
    narrowTo === null ? found.hits : found.hits.filter((hit) => hit.session.projectId === narrowTo);
  const announced = resultCountLabel(locale, t, ranked.count + hits.length);
  const searchLine =
    found.status === "loading"
      ? t("search.loading")
      : found.status === "error"
        ? t(searchErrorKey(found.code))
        : null;
  // cmdk does not move its selection onto rows that were disabled and are enabled again: the selection is kept
  // here, and falls back to the first row that can be chosen.
  const [selected, setSelected] = useState("");
  const choosable = [
    ...ranked.groups.flatMap((entry) => entry.items.map((item) => item.id)),
    ...(found.status === "loading" ? [] : hits.map(hitValue)),
  ];
  const value = choosable.includes(selected) ? selected : (choosable[0] ?? "");
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
    <RankedGroup key={entry.group} entry={entry} current={value} onChoose={run} />
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
        <Command
          shouldFilter={false}
          loop
          value={value}
          onValueChange={setSelected}
          label={t("commands.palette.dialog")}
        >
          <Command.Input
            ref={input}
            aria-label={inputLabel}
            placeholder={inputLabel}
            value={query}
            onValueChange={setQuery}
            className="w-full border-b border-border bg-transparent px-s3 py-s2 text-ui text-fg outline-none focus:border-agent"
          />
          <Command.List className="max-h-app overflow-y-auto p-s1">
            {searchLine === null ? (
              <Command.Empty className="px-s3 py-s2 text-ui text-muted">
                {scope !== null
                  ? t(searchText(query) === null ? "search.mode.short" : "search.mode.none")
                  : ranked.actionsOnly
                    ? t("commands.palette.emptyActions")
                    : t("commands.palette.empty")}
              </Command.Empty>
            ) : null}
            {ranked.groups.filter((entry) => !AFTER_HITS.has(entry.group)).map(renderGroup)}
            {hits.length > 0 ? (
              <TranscriptHits
                hits={hits}
                current={value}
                loading={found.status === "loading"}
                onChoose={choose}
              />
            ) : null}
            {ranked.groups.filter((entry) => AFTER_HITS.has(entry.group)).map(renderGroup)}
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
