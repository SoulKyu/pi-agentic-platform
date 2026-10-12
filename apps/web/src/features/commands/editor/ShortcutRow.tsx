import { Button, Chip, Kbd } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import type { CommandSpec } from "../defaults.ts";
import type { Platform } from "../keys.ts";
import { chordJoiner, chordTokens, keyNames } from "../labels.ts";
import type { ResolvedRule } from "../resolve.ts";
import { ShortcutRecorder } from "./ShortcutRecorder.tsx";

export interface ShortcutRowProps {
  readonly spec: CommandSpec;
  /** The rule in force, null when the command has no binding. */
  readonly rule: ResolvedRule | null;
  /** The user's rules decide this command (a rebinding, or a removal). */
  readonly custom: boolean;
  /** Titles of the commands sharing this chord, already joined for the language; null when none. */
  readonly conflicts: string | null;
  readonly reserved: boolean;
  readonly platform: Platform;
  onRecord(chord: string): void;
  onReset(): void;
  onRemove(): void;
}

/** One command: its chord, where it comes from, what is wrong with it, and what can be done. */
export function ShortcutRow(props: ShortcutRowProps) {
  const t = useT();
  const { spec, rule, custom } = props;
  const title = t(spec.titleKey, spec.titleVars);
  return (
    <li
      data-command={spec.id}
      className="flex flex-wrap items-center gap-s2 border-b border-border py-s2 text-ui"
    >
      <span className="min-w-0 flex-1 text-fg">{title}</span>
      {rule === null ? (
        <span className="text-muted">{t("settings.shortcuts.unassigned")}</span>
      ) : (
        <Kbd
          keys={chordTokens(rule.chord, props.platform, keyNames(t))}
          joiner={chordJoiner(props.platform)}
        />
      )}
      <Chip
        tone={custom ? "run" : "mut"}
        label={t(custom ? "settings.shortcuts.badge.custom" : "settings.shortcuts.badge.default")}
      />
      <ShortcutRecorder
        command={spec.id}
        commandTitle={title}
        platform={props.platform}
        onRecord={props.onRecord}
      />
      {custom ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("settings.shortcuts.resetFor", { command: title })}
          onClick={props.onReset}
        >
          {t("settings.shortcuts.reset")}
        </Button>
      ) : null}
      {rule === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("settings.shortcuts.removeFor", { command: title })}
          onClick={props.onRemove}
        >
          {t("settings.shortcuts.remove")}
        </Button>
      )}
      {props.conflicts === null ? null : (
        <p data-slot="shortcut-warning" className="basis-full text-attn">
          {t("settings.shortcuts.conflict", { commands: props.conflicts })}
        </p>
      )}
      {props.reserved ? (
        <p data-slot="shortcut-warning" className="basis-full text-attn">
          {t("settings.shortcuts.reservedWarning")}
        </p>
      ) : null}
    </li>
  );
}
