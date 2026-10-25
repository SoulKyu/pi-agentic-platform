import { Button, InlineError } from "@pap/ui";
import { useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../../i18n/index.ts";
import { chordFromEvent, type Platform } from "../keys.ts";
import { recordedChordProblem } from "./keybindings-io.ts";

const LONE_MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock"]);
const IGNORED_KEYS = new Set(["Process", "Dead", "Unidentified"]);

export interface ShortcutRecorderProps {
  readonly command: string;
  readonly commandTitle: string;
  readonly platform: Platform;
  onRecord(chord: string): void;
}

/**
 * Orca's recorder: a button the dispatcher skips (`data-shortcut-recorder`). While recording it keeps every key from the
 * rest of the page, Escape cancels (and only cancels), and a chord is handed over only when it is allowed.
 */
export function ShortcutRecorder({ command, commandTitle, platform, onRecord }: ShortcutRecorderProps) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<"no_modifier" | "reserved" | "unusable" | "altgr" | null>(null);
  // A key released after the recording ended must not click the button again (Space activates on keyup).
  const swallowKeyUp = useRef(false);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    swallowKeyUp.current = true;
    const native = event.nativeEvent;
    if (event.repeat || native.isComposing || IGNORED_KEYS.has(event.key) || LONE_MODIFIERS.has(event.key))
      return;
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      setRecording(false);
      setProblem(null);
      return;
    }
    const chord = chordFromEvent(native, platform);
    // `chordFromEvent` refuses Ctrl+Alt when the system reports AltGr: say so rather than "unusable".
    const altGr = platform === "other" && event.ctrlKey && event.altKey;
    const refused =
      chord === null ? (altGr ? "altgr" : "unusable") : recordedChordProblem(chord, command, platform);
    setProblem(refused);
    if (chord === null || refused !== null) return;
    setRecording(false);
    onRecord(chord);
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        data-shortcut-recorder=""
        aria-pressed={recording}
        aria-label={t("settings.shortcuts.changeFor", { command: commandTitle })}
        onClick={(event) => {
          setProblem(null);
          if (recording) {
            setRecording(false);
            return;
          }
          // Safari leaves a clicked button unfocused, and the keys go to the focused element.
          event.currentTarget.focus();
          setRecording(true);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (!swallowKeyUp.current) return;
          swallowKeyUp.current = false;
          event.preventDefault();
        }}
        onBlur={() => {
          setRecording(false);
        }}
      >
        {recording ? t("settings.shortcuts.recording") : t("settings.shortcuts.change")}
      </Button>
      {problem === null ? null : (
        <div data-slot="shortcut-problem" className="basis-full">
          <InlineError announce="action">{t(`settings.shortcuts.problem.${problem}`)}</InlineError>
        </div>
      )}
    </>
  );
}
