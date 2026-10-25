import "./register-space-catalog.ts";
import { Button, copyText } from "@pap/ui";
import { useId, useState } from "react";
import { useT } from "../../i18n/index.ts";

/** One secret shown once: a read-only field and a copy button. The value is a prop; nothing here keeps it elsewhere. */
export function SecretReveal({ name, secret }: { readonly name: string; readonly secret: string }) {
  const t = useT();
  const id = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex flex-col gap-s1">
      <label htmlFor={id} className="text-ui text-fg">
        {name}
      </label>
      <div className="flex items-center gap-s2">
        <input
          id={id}
          readOnly
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onFocus={(event) => event.currentTarget.select()}
          className="h-control min-w-0 flex-1 rounded-sm border border-control-border bg-bg px-s2 font-mono text-code text-fg focus-ring"
        />
        <Button
          size="sm"
          aria-label={t("agentSafety.q.copy.label", { name })}
          onClick={() => void copyText(secret).then((done) => setCopy(done ? "copied" : "failed"))}
        >
          {t("agentSafety.q.copy")}
        </Button>
      </div>
      {copy === "idle" ? null : (
        <p role="status" className="text-label text-muted">
          {t(copy === "copied" ? "agentSafety.q.copied" : "agentSafety.q.copyFailed")}
        </p>
      )}
    </div>
  );
}
