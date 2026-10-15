import { TriggerView } from "@pap/contracts";
import { Spinner } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";
import { browserZone, draftOf, emptyDraft } from "./editor.vm.ts";
import { TriggerForm } from "./TriggerForm.tsx";

export interface TriggerEditorProps {
  /** A trigger's id, or `new:<project id>` for an empty editor. */
  readonly triggerId: string;
  /** The home's Trigger launch (§3.1): the new trigger's name and prompt. Read once, when the editor mounts. */
  readonly prefill?: TriggerPrefill | null;
  onOpenSession(sessionId: string): void;
  onOpenTasks(): void;
  /** A new trigger was created: the shell swaps the `new:` tab for the saved trigger's own. */
  onCreated?(id: string): void;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly view: TriggerView };

function SavedTrigger({ triggerId, onOpenSession }: Pick<TriggerEditorProps, "triggerId" | "onOpenSession">) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("automation.triggers.get", { triggerId })
      .then(
        (answer) => {
          const view = TriggerView.safeParse(answer);
          if (current) setLoaded(view.success ? { kind: "ready", view: view.data } : { kind: "failed" });
        },
        () => {
          if (current) setLoaded({ kind: "failed" });
        },
      );
    return () => {
      current = false;
    };
  }, [triggerId]);

  if (loaded.kind === "loading") return <Spinner label={t("automation.editor.loading")} />;
  if (loaded.kind === "failed")
    return (
      <p role="alert" className="p-s3 text-ui text-err">
        {t("automation.editor.loadFailed")}
      </p>
    );
  const draft = draftOf(loaded.view, emptyDraft(loaded.view.cwd, browserZone()));
  if (draft === null)
    return (
      <p role="alert" className="p-s3 text-ui text-err">
        {t("automation.editor.unreadable")}
      </p>
    );
  return <TriggerForm view={loaded.view} draft={draft} onOpenSession={onOpenSession} />;
}

/**
 * The trigger tab (decision 31, board 11 §1): loads a saved trigger, or starts a new one in its project's folder and the
 * browser's zone (RT-34). Features never import each other, so the session link goes out through the pane's callback.
 */
export function TriggerEditor({ triggerId, prefill, onOpenSession, onCreated }: TriggerEditorProps) {
  const project = useShellStore((state) => state.view.projects.get(triggerId.slice("new:".length)));
  return (
    <section data-trigger-pane="" className="flex min-h-0 flex-1 flex-col">
      {triggerId.startsWith("new:") ? (
        <TriggerForm
          view={null}
          draft={{
            ...emptyDraft(project?.root ?? "", browserZone()),
            ...(prefill ? { name: prefill.name, prompt: prefill.prompt } : {}),
          }}
          onOpenSession={onOpenSession}
          {...(onCreated ? { onCreated } : {})}
        />
      ) : (
        <SavedTrigger triggerId={triggerId} onOpenSession={onOpenSession} />
      )}
    </section>
  );
}
