import "../../i18n/register-sidebar.ts";
import { SNOOZE_MAX_MS, SNOOZE_MIN_MS } from "@pap/contracts";
import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useId, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { snoozeTimes, toLocalInput } from "./snooze.ts";

const FIELD_CLASSES =
  "h-control w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 text-ui text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base";

interface SnoozeDialogProps {
  onClose(): void;
  onSubmit(until: number): void;
}

/** "Snooze until…": a date and time in the device's local time, at least a minute ahead and within 366 days (M4R100). */
export default function SnoozeDialog({ onClose, onSubmit }: SnoozeDialogProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(() => toLocalInput(snoozeTimes(new Date()).tomorrow));
  const [error, setError] = useState<string | null>(null);

  // Worked out when the dialog opens; submit checks again against the clock at that moment.
  const [bounds] = useState(() => {
    const now = Date.now();
    return { min: toLocalInput(now + SNOOZE_MIN_MS), max: toLocalInput(now + SNOOZE_MAX_MS) };
  });

  const submit = () => {
    const until = new Date(value).getTime();
    const now = Date.now();
    if (Number.isNaN(until) || until < now + SNOOZE_MIN_MS) return setError(t("sidebar.snooze.tooSoon"));
    if (until > now + SNOOZE_MAX_MS) return setError(t("sidebar.snooze.tooLate"));
    onSubmit(until);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("sidebar.snooze.title")}
      closeLabel={t("ui.close")}
      initialFocus={input}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("sidebar.snooze.cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t("sidebar.snooze.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s1 p-s3">
        <label htmlFor={id} className="label-hud text-muted">
          {t("sidebar.snooze.when")}
        </label>
        <input
          ref={input}
          id={id}
          type="datetime-local"
          value={value}
          min={bounds.min}
          max={bounds.max}
          aria-invalid={error ? true : undefined}
          className={FIELD_CLASSES}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {error ? (
          <p role="alert" className="text-ui text-attn">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
