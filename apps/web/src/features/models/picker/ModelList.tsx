import { Button, cn } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "../../../i18n/register-model-picker.ts";
import { useT } from "../../../i18n/index.ts";
import { groupAndRank, modelKey, shownText, type PickerGroup, type PickerModel } from "./model-picker.vm.ts";
import type { AvailableState } from "./use-available-models.ts";

interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** Models only an extension registers, read on a click (ADR 0070 as amended): listed after the list's own groups. */
export interface ExtensionPart {
  readonly models: readonly PickerModel[];
  readonly labels: ReadonlyMap<string, string>;
  /** Providers whose model list the read cut short. */
  readonly modelsTruncated: ReadonlySet<string>;
  /** Shown under the list (the button and the read's state); `useFocusSearch` gives it the way back to the search box. */
  readonly controls: ReactNode;
}

const FocusSearch = createContext<() => void>(() => {});

/** For the content under the list: puts the focus back in the search box, where the arrows reach the rows. */
export const useFocusSearch = (): (() => void) => useContext(FocusSearch);

export interface ModelListProps {
  readonly state: AvailableState;
  readonly value: ModelRef | null;
  onPick(model: PickerModel): void;
  /** MPR5: the saved choice that the list no longer offers; shown first, still pickable. */
  readonly savedUnavailable?: ModelRef | null;
  /** What the saved row says (default: "Saved model, no longer offered"). */
  readonly savedNote?: string;
  readonly extension?: ExtensionPart;
  /** Content beside a row (outside its option): the session menu's star. */
  readonly renderRowEnd?: (model: PickerModel) => ReactNode;
  readonly footnote?: string;
  /** A first row ("Pi's default") that picks no model; picking it calls `onPickDefault`. */
  readonly defaultLabel?: string;
  onPickDefault?(): void;
  /** Rows ignore picks (a switch is in flight). */
  readonly disabled?: boolean;
}

/** Rows a group shows before "show more" (as `EnabledSwitches` does with 100). */
const GROUP_ROWS = 200;
const PAGE = 10;

type Entry =
  | { readonly key: string; readonly kind: "default"; readonly label: string }
  | { readonly key: string; readonly kind: "saved" | "model"; readonly model: PickerModel };

/** An extension's provider may share its id with one of the list's (it overrides it): its keys never collide. */
const EXT = "ext:";

/** A group's rows as shown: the first `GROUP_ROWS` until "show more" expanded it. */
const rowsOf = (group: PickerGroup, prefix: string, expanded: ReadonlySet<string>) =>
  expanded.has(prefix + group.provider) ? group.rows : group.rows.slice(0, GROUP_ROWS);

const ROW_CLASSES =
  "flex h-control min-w-0 flex-1 cursor-pointer items-center gap-s2 rounded-sm px-s2 text-ui text-fg pointer-coarse:min-h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const INPUT_CLASSES =
  "h-control w-full rounded-sm border border-control-border bg-bg px-s2 font-sans text-ui text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base";

const savedModel = (ref: ModelRef): PickerModel => ({
  provider: ref.provider,
  id: ref.modelId,
  name: shownText(ref.modelId),
  reasoning: false,
});

/**
 * The model list (MPR6): a search box that is a combobox, then a scrolling listbox grouped by provider in the source's
 * order. The keys stay on the search input, so the caret keeps Home and End. Lazy: only the field's import loads it.
 */
export default function ModelList({
  state,
  value,
  onPick,
  savedUnavailable: savedProp,
  savedNote,
  extension,
  renderRowEnd,
  footnote,
  defaultLabel,
  onPickDefault,
  disabled: disabledProp,
}: ModelListProps) {
  const savedUnavailable = savedProp ?? null;
  const disabled = disabledProp ?? false;
  const t = useT();
  const id = useId();
  const listId = `${id}-list`;
  const inputId = `${id}-search`;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => inputRef.current?.focus(), []);

  const ready = state.status === "ready" ? state : null;
  const groups = useMemo(
    () => (ready ? groupAndRank(ready.models, ready.labels, query) : []),
    [ready, query],
  );
  const extensionGroups = useMemo(
    () => (extension ? groupAndRank(extension.models, extension.labels, query) : []),
    [extension, query],
  );
  const searching = query.trim() !== "";

  const entries = useMemo(() => {
    const out: Entry[] = [];
    if (!searching && defaultLabel !== undefined)
      out.push({ key: "default", kind: "default", label: defaultLabel });
    if (!searching && savedUnavailable)
      out.push({
        key: `saved:${modelKey({ provider: savedUnavailable.provider, id: savedUnavailable.modelId })}`,
        kind: "saved",
        model: savedModel(savedUnavailable),
      });
    for (const group of groups)
      for (const model of rowsOf(group, "", expanded))
        out.push({ key: modelKey(model), kind: "model", model });
    for (const group of extensionGroups)
      for (const model of rowsOf(group, EXT, expanded))
        out.push({ key: EXT + modelKey(model), kind: "model", model });
    return out;
  }, [groups, extensionGroups, expanded, searching, defaultLabel, savedUnavailable]);

  const isSelected = (entry: Entry): boolean =>
    entry.kind === "default"
      ? value === null
      : value !== null && entry.model.provider === value.provider && entry.model.id === value.modelId;
  const selectedIndex = entries.findIndex(isSelected);
  const found = activeKey === null ? -1 : entries.findIndex((entry) => entry.key === activeKey);
  const activeIndex = found !== -1 ? found : searching ? 0 : Math.max(0, selectedIndex);
  const optionId = (index: number) => `${id}-opt-${index}`;
  const activeId = optionId(activeIndex);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[id="${activeId}"]`);
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [activeId, activeKey]);

  const pick = (entry: Entry | undefined) => {
    if (!entry || disabled) return;
    if (entry.kind === "default") onPickDefault?.();
    else onPick(entry.model);
  };
  const moveTo = (index: number) => setActiveKey(entries[index]?.key ?? null);
  const focusSearch = () => inputRef.current?.focus();

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = entries.length - 1;
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      pick(entries[activeIndex]);
      return;
    }
    if (last < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(activeIndex + 1, last);
    else if (event.key === "ArrowUp") next = Math.max(activeIndex - 1, 0);
    else if (event.key === "PageDown") next = Math.min(activeIndex + PAGE, last);
    else if (event.key === "PageUp") next = Math.max(activeIndex - PAGE, 0);
    else if (event.ctrlKey && event.key === "Home") next = 0;
    else if (event.ctrlKey && event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    moveTo(next);
  };

  const rowFor = (entry: Entry, index: number): ReactNode => {
    const label =
      entry.kind === "default"
        ? entry.label
        : entry.model.name === ""
          ? shownText(entry.model.id)
          : entry.model.name;
    const model = entry.kind === "default" ? null : entry.model;
    return (
      <div key={entry.key} role="presentation" className="flex items-center">
        <div
          role="option"
          id={optionId(index)}
          {...(model ? { "data-model-row": model.id } : { "data-model-default": "" })}
          aria-selected={isSelected(entry)}
          aria-disabled={disabled ? true : undefined}
          className={cn(
            ROW_CLASSES,
            index === activeIndex && "bg-surface-2",
            isSelected(entry) && "text-agent",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActiveKey(entry.key)}
          onClick={() => pick(entry)}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {entry.kind === "saved" ? (
            <>
              <span className="min-w-0 truncate text-muted">{shownText(entry.model.provider)}</span>
              <span className={cn("shrink-0", savedNote === undefined ? "text-attn" : "text-muted")}>
                {savedNote ?? t("modelPicker.notOffered")}
              </span>
            </>
          ) : model && model.name !== "" && model.name !== model.id ? (
            <span className="min-w-0 truncate text-muted">{shownText(model.id)}</span>
          ) : null}
          {isSelected(entry) ? (
            <span aria-hidden="true" className="shrink-0">
              ✓
            </span>
          ) : null}
        </div>
        {model && renderRowEnd ? renderRowEnd(model) : null}
      </div>
    );
  };

  const indexOf = new Map(entries.map((entry, index) => [entry.key, index] as const));
  const leading = entries.filter((entry) => entry.kind !== "model");
  const added = extension?.models.length ?? 0;
  const empty = ready !== null && ready.models.length === 0 && added === 0;

  const groupFor = (group: PickerGroup, prefix: string): ReactNode => {
    const shown = rowsOf(group, prefix, expanded);
    const mark = prefix === EXT ? t("modelPicker.extensions.mark") : null;
    return (
      <div
        key={prefix + group.provider}
        role="group"
        aria-label={mark === null ? group.label : `${group.label}, ${mark}`}
        {...(mark === null
          ? { "data-model-group": group.provider }
          : { "data-extension-group": group.provider })}
      >
        <div role="presentation" className="flex min-w-0 items-baseline gap-s2 px-s2 pt-s2">
          <span className="label-hud truncate text-muted">{group.label}</span>
          {mark === null ? null : <span className="shrink-0 text-ui text-muted">{mark}</span>}
        </div>
        {shown.map((model) => {
          const key = prefix + modelKey(model);
          return rowFor({ key, kind: "model", model }, indexOf.get(key) ?? 0);
        })}
        {shown.length < group.rows.length ? (
          <Button
            variant="ghost"
            onClick={() => setExpanded((now) => new Set(now).add(prefix + group.provider))}
          >
            {t("modelPicker.showMore", { count: String(group.rows.length - shown.length) })}
          </Button>
        ) : null}
        {mark !== null && extension?.modelsTruncated.has(group.provider) ? (
          <p className="px-s2 text-ui text-muted">{t("modelPicker.extensions.modelsTruncated")}</p>
        ) : null}
      </div>
    );
  };
  const failed = state.status === "failed" ? state : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s1 p-s1">
      <label htmlFor={inputId} className="sr-only">
        {t("modelPicker.search")}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        name="model-search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={entries.length > 0 ? activeId : undefined}
        autoComplete="off"
        spellCheck={false}
        className={INPUT_CLASSES}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveKey(null);
        }}
        onKeyDown={onKeyDown}
      />
      {state.status === "loading" ? (
        <p role="status" className="px-s2 text-ui text-muted">
          {t("modelPicker.loading")}
        </p>
      ) : null}
      {failed ? (
        <div className="flex flex-col items-start gap-s2 px-s2">
          <p role="alert" className="text-ui text-attn">
            {failed.stale ? t("modelPicker.reload") : (failed.message ?? t("modelPicker.failed"))}
          </p>
          <Button onClick={failed.reload}>{t("modelPicker.retry")}</Button>
        </div>
      ) : null}
      {empty ? (
        <p className="px-s2 text-ui text-fg">
          {t("modelPicker.empty")}{" "}
          <Link
            to="/settings/$section"
            params={{ section: "models" }}
            className="text-fg underline focus-ring"
          >
            {t("modelPicker.settings")}
          </Link>
        </p>
      ) : null}
      {ready && !empty && groups.length === 0 && extensionGroups.length === 0 ? (
        <p className="px-s2 text-ui text-muted">{t("modelPicker.noMatch")}</p>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("modelPicker.list")}
        className="flex min-h-0 max-h-popover flex-1 flex-col overflow-y-auto"
      >
        {leading.map((entry) => rowFor(entry, indexOf.get(entry.key) ?? 0))}
        {groups.map((group) => groupFor(group, ""))}
        {extensionGroups.map((group) => groupFor(group, EXT))}
      </div>
      {extension ? (
        <FocusSearch.Provider value={focusSearch}>{extension.controls}</FocusSearch.Provider>
      ) : null}
      {ready?.truncated ? <p className="px-s2 text-ui text-muted">{t("modelPicker.truncated")}</p> : null}
      {footnote ? <p className="px-s2 text-ui text-muted">{footnote}</p> : null}
    </div>
  );
}
