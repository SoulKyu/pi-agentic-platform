import { Tooltip } from "@pap/ui";
import { type ReactElement, useId, useRef } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import type { HomeChord } from "./home-actions.ts";
import { HOME_MODES, type HomeMode } from "./home-mode.ts";

const CHIP_CLASSES =
  "inline-flex h-control items-center rounded-sm border border-control-border px-s2 label-hud text-muted focus-ring aria-checked:border-agent aria-checked:text-fg aria-disabled:opacity-50 pointer-coarse:min-h-11";

const STEPS: Readonly<Record<string, 1 | -1 | "first" | "last">> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

interface Props {
  /** The mode shown checked (a refused one shows Session). */
  readonly mode: HomeMode;
  readonly reasons: Partial<Record<HomeMode, MessageKey>>;
  readonly laneChord: HomeChord;
  onMode(mode: HomeMode): void;
}

/**
 * §3.1 and §7: Session · Lane · Fan-out · Trigger as one radiogroup (a roving tab stop, arrow keys, Home and End). A mode
 * that cannot run stays visible, `aria-disabled`, and its reason is a visible line its `aria-describedby` names.
 */
export function ModeChips({ mode, reasons, laneChord, onMode }: Props) {
  "use no memo"; // first-paint component: the compiler's cache slots would cost bundle (the initialBundleGzipKb ceiling in budgets.json)
  const t = useT();
  const group = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const open = HOME_MODES.filter((one) => reasons[one] === undefined);
  const lines = [...new Set(HOME_MODES.flatMap((one) => reasons[one] ?? []))];
  const move = (step: 1 | -1 | "first" | "last") => {
    const at = open.indexOf(mode);
    const next =
      step === "first"
        ? open[0]
        : step === "last"
          ? open.at(-1)
          : open[(at + step + open.length) % open.length];
    if (next === undefined) return;
    onMode(next);
    group.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <div className="flex flex-col gap-s1">
      <div
        ref={group}
        role="radiogroup"
        aria-label={t("launch.modes")}
        className="flex flex-wrap gap-s1"
        onKeyDown={(event) => {
          const step = STEPS[event.key];
          if (step === undefined) return;
          event.preventDefault();
          move(step);
        }}
      >
        {HOME_MODES.map((one) => {
          const reason = reasons[one];
          const chip: ReactElement = (
            <button
              key={one}
              type="button"
              role="radio"
              data-mode={one}
              aria-checked={mode === one}
              aria-disabled={reason === undefined ? undefined : true}
              aria-describedby={reason === undefined ? undefined : `${reasonId}-${lines.indexOf(reason)}`}
              tabIndex={mode === one ? 0 : -1}
              className={CHIP_CLASSES}
              onClick={() => {
                if (reason === undefined) onMode(one);
              }}
            >
              {t(`launch.mode.${one}`)}
            </button>
          );
          return one === "lane" && laneChord.keys.length > 0 ? (
            <Tooltip
              key={one}
              label={t("launch.hint.lane")}
              shortcut={laneChord.keys}
              shortcutJoiner={laneChord.joiner}
            >
              {chip}
            </Tooltip>
          ) : (
            chip
          );
        })}
      </div>
      {lines.map((line, index) => (
        <p key={line} id={`${reasonId}-${index}`} className="text-ui text-muted">
          {t(line)}
        </p>
      ))}
    </div>
  );
}
