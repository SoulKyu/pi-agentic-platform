import { Button, InlineError, TextField } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { AuditRow } from "./AuditRow.tsx";
import { AUDIT_SESSION_ID_MAX } from "@pap/contracts";
import { MAX_ROWS } from "./audit.vm.ts";
import { useAuditLog } from "./use-audit-log.ts";

const NOTE = "text-ui text-muted";

/** Settings › Approvals: what every stage decided, newest first, read-only (owner Q6, M5R93). */
export function AuditLog() {
  const t = useT();
  const log = useAuditLog();
  const [typed, setTyped] = useState("");
  const [tooLong, setTooLong] = useState(false);
  return (
    <section className="flex flex-col gap-s3">
      <h2 className="text-ui font-semibold text-fg">{t("audit.title")}</h2>
      <p className={NOTE}>{t("audit.intro")}</p>
      <form
        className="flex items-end gap-s2"
        onSubmit={(event) => {
          event.preventDefault();
          const tooBig = typed.trim().length > AUDIT_SESSION_ID_MAX;
          setTooLong(tooBig);
          if (!tooBig) log.apply(typed);
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField
            label={t("audit.filter")}
            value={typed}
            error={tooLong ? t("audit.filterTooLong", { max: AUDIT_SESSION_ID_MAX }) : null}
            onChange={(value) => {
              setTyped(value);
              setTooLong(false);
            }}
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="secondary">
          {t("audit.apply")}
        </Button>
      </form>
      {log.error ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">{log.error}</InlineError>
          <Button variant="secondary" disabled={log.busy} onClick={log.retry}>
            {t("audit.retry")}
          </Button>
        </div>
      ) : null}
      {!log.loaded && !log.error ? <p className={NOTE}>{t("audit.loading")}</p> : null}
      {log.loaded && log.entries.length === 0 ? (
        <p className={NOTE}>{t(log.filter === "" ? "audit.empty" : "audit.emptyFiltered")}</p>
      ) : null}
      <ul className="flex flex-col">
        {log.entries.map((row) => (
          <AuditRow key={row.id} row={row} />
        ))}
      </ul>
      {log.capped ? <p className={NOTE}>{t("audit.capped", { count: MAX_ROWS })}</p> : null}
      {log.canLoadOlder ? (
        <div>
          <Button variant="secondary" disabled={log.busy} onClick={log.loadOlder}>
            {t("audit.older")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
