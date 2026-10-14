import { Button } from "@pap/ui";
import { useRef } from "react";
import { useT } from "../../../i18n/index.ts";
import "./register-files-catalog.ts";
import type { Attachments } from "./use-attachments.ts";

/** Opens the system file picker: no `accept` and no `capture`, so a phone offers its files and its camera alike. */
export function AttachButton({ attachments }: { readonly attachments: Attachments }) {
  const t = useT();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button type="button" variant="ghost" onClick={() => input.current?.click()}>
        {t("sessions.files.attach")}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        data-attach-input
        onChange={(event) => {
          attachments.add(Array.from(event.target.files ?? []), 0);
          event.target.value = "";
        }}
      />
    </>
  );
}
