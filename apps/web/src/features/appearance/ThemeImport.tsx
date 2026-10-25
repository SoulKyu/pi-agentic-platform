import { Button, InlineError } from "@pap/ui";
import { useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { readThemeFile, type ThemeFileError, type ThemeFileResult } from "./theme-io.ts";

/** A button over a hidden file input; the file is size-checked before it is read (M3R118). */
export function ImportButton({
  disabled,
  onResult,
}: {
  readonly disabled?: boolean;
  onResult(result: ThemeFileResult): void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="secondary" disabled={disabled === true} onClick={() => input.current?.click()}>
        {t("settings.theme.import")}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept="application/json,.json"
        aria-label={t("settings.theme.import")}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file === undefined) return;
          readThemeFile(file)
            .then(onResult)
            .catch(() => reportClientIssue("command_failed"));
        }}
      />
    </>
  );
}

/** What the file got wrong, entry by entry; paths are clipped by the parser and rendered as text. */
export function ImportErrors({ errors }: { readonly errors: readonly ThemeFileError[] }) {
  const t = useT();
  if (errors.length === 0) return null;
  return (
    <div data-slot="theme-import-errors" className="flex flex-col gap-s1">
      <InlineError announce="action">{t("settings.theme.importErrors")}</InlineError>
      <ul className="list-disc pl-s4 text-ui text-err">
        {errors.map((error, index) => (
          <li key={index}>
            {error.kind === "invalid"
              ? t("settings.theme.importError.invalid", { path: error.path })
              : t(`settings.theme.importError.${error.kind}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}
