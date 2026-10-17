import { Button, Segmented } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import { shownText } from "../picker/model-picker.vm.ts";
import type { AvailabilityMode } from "./availability.vm.ts";

/** Patterns the confirmation spells out; the rest is counted. */
const PATTERNS_SHOWN = 20;

/**
 * The mode first (owner q3, MPR16): all models of the connected providers, or my selection. Choosing the selection
 * calls nothing (it is the screen's mode until the first switch). Choosing all models deletes the saved list with no
 * undo, so it asks first, names how many entries it removes and keeps the old list readable in the question (MPR16).
 */
export function ModeSwitch({
  shown,
  patterns,
  busy,
  onSelection,
  onAll,
  onClear,
}: {
  readonly shown: AvailabilityMode;
  readonly patterns: readonly string[] | null;
  readonly busy: boolean;
  onSelection(): void;
  /** There is no list to delete: the mode changes on screen only. */
  onAll(): void;
  onClear(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const [asking, setAsking] = useState(false);
  const question = useRef<HTMLDivElement>(null);
  // The question opens below the control: the focus goes to it, so a keyboard user answers it next (carry of task 14).
  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const choose = (next: AvailabilityMode) => {
    if (next === "selection") {
      setAsking(false);
      onSelection();
    } else if (patterns === null) onAll();
    else if (patterns.length === 0) onClear();
    else setAsking(true);
  };
  const list = patterns ?? [];
  return (
    <div className="flex flex-col items-start gap-s2">
      <Segmented
        label={t("settingsAvailability.mode.label")}
        value={shown}
        options={[
          { value: "all", label: t("settingsAvailability.mode.all") },
          { value: "selection", label: t("settingsAvailability.mode.selection") },
        ]}
        onChange={choose}
      />
      {asking ? (
        <div
          ref={question}
          tabIndex={-1}
          role="group"
          aria-label={plural(locale, "settingsAvailability.confirm.ask", list.length)}
          className="flex flex-col items-start gap-s2"
        >
          <p className="text-ui text-fg">{plural(locale, "settingsAvailability.confirm.ask", list.length)}</p>
          <p className="label-hud text-muted">{t("settingsAvailability.confirm.list")}</p>
          <ul className="flex flex-col gap-s1 text-ui text-muted">
            {list.slice(0, PATTERNS_SHOWN).map((pattern, index) => (
              <li key={`${index}:${pattern}`}>{shownText(pattern)}</li>
            ))}
            {list.length > PATTERNS_SHOWN ? (
              <li>{t("settingsAvailability.confirm.more", { count: list.length - PATTERNS_SHOWN })}</li>
            ) : null}
          </ul>
          <div className="flex gap-s2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                onClear();
              }}
            >
              {t("settingsAvailability.confirm.yes")}
            </Button>
            <Button onClick={() => setAsking(false)}>{t("settingsAvailability.confirm.no")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
