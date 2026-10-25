import "../../i18n/register-github.ts";
import { Fence, InlineError } from "@pap/ui";
import { useEffect, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { githubFailure } from "./github-errors.ts";

type LogState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly key: MessageKey }
  | { readonly kind: "ready"; readonly text: string; readonly truncated: boolean };

/** The end of a failed check's log, as text only inside the fence: it is GitHub's, so never HTML, markdown or links. */
export function CheckLog({ projectId, checkId }: { readonly projectId: string; readonly checkId: string }) {
  const t = useT();
  const [state, setState] = useState<LogState>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("projects.checkLog", { projectId, checkId })
      .then(
        ({ text, truncated }) => {
          if (current) setState({ kind: "ready", text, truncated });
        },
        (failure: unknown) => {
          if (current) setState({ kind: "failed", key: githubFailure(failure) });
        },
      );
    return () => {
      current = false;
    };
  }, [projectId, checkId]);

  if (state.kind === "loading")
    return (
      <p role="status" className="text-ui text-muted">
        {t("github.log.loading")}
      </p>
    );
  if (state.kind === "failed") return <InlineError announce="background">{t(state.key)}</InlineError>;
  return (
    <div className="flex flex-col gap-s1">
      <Fence label={t("github.fence.log")}>{state.text === "" ? t("github.log.empty") : state.text}</Fence>
      {state.truncated ? <p className="text-ui text-muted">{t("github.log.truncated")}</p> : null}
    </div>
  );
}
