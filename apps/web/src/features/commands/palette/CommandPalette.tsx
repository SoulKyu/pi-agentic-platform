import { Kbd } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Command } from "cmdk";
import { useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../../../i18n/index.ts";
import { rankItems, type PaletteItem } from "./rank.ts";
import { resultCountLabel } from "./result-count.ts";

interface CommandPaletteProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly items: readonly PaletteItem[];
}

/**
 * Orca's palette on cmdk with its own filter off: `rankItems` orders and counts, cmdk only moves the selection.
 * Loaded on first open (spec C §7.4). No digit chords here: the browser keeps Ctrl/⌘/Alt+1..9 (M3-RT-31).
 */
export default function CommandPalette({ open, onOpenChange, items }: CommandPaletteProps) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ranked = useMemo(() => rankItems(items, query), [items, query]);
  const announced = resultCountLabel(locale, t, ranked.count);
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
            <Command.Empty className="px-s3 py-s2 text-ui text-muted">
              {ranked.actionsOnly ? t("commands.palette.emptyActions") : t("commands.palette.empty")}
            </Command.Empty>
            {ranked.groups.map(({ group, items: rows }) => (
              <Command.Group
                key={group}
                heading={t(`commands.palette.group.${group}`)}
                className="text-label text-muted"
              >
                {rows.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={item.id}
                    onSelect={() => {
                      onOpenChange(false);
                      item.run();
                    }}
                    className="flex items-center justify-between gap-s2 rounded-sm px-s2 py-s1 text-ui text-fg aria-selected:bg-surface-2"
                  >
                    <span className="truncate">{item.title}</span>
                    {item.detail ? (
                      <span className="min-w-0 flex-1 truncate font-mono text-code text-muted">
                        {item.detail}
                      </span>
                    ) : null}
                    {item.chord ? <Kbd keys={item.chord} joiner={item.chordJoiner ?? ""} /> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
        <p className="sr-only" aria-live="polite">
          {announced}
        </p>
      </div>
    </Dialog>
  );
}
