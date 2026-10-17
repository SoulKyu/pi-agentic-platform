import { useEffect, useRef, useState } from "react";
import { failureCode } from "../failure.ts";
import type { StepUpRunner } from "../step-up.ts";
import { type Draft, issueTargets, type IssueTargets, type Problem, toInput } from "./provider-form.vm.ts";
import { providerRpc } from "./provider-rpc.ts";

export const NO_ISSUES: IssueTargets = { file: false, providers: false, other: false, at: new Set() };

/** Why `models.provider.get` is called again: after a save (the draft is the file's) or after a conflict (the draft stays). */
export type LoadMode = "saved" | "conflict";

export interface UseProviderSaveInput {
  /** Which form target this is; an answer that comes back for another target is dropped. */
  readonly targetKey: string;
  readonly ready: boolean;
  readonly editing: boolean;
  readonly draft: Draft;
  readonly problems: readonly Problem[];
  /** The revision `models.provider.get` returned, never a fresh read (MP-RT-03). */
  readonly revision: string;
  readonly stepUp: StepUpRunner;
  /** `models.provider.get` again; resolves to the failure code, or null when it worked. */
  reload(id: string | undefined, mode: LoadMode): Promise<string | null>;
  /** A new provider is in the file: the form is an update from now on. */
  onCreated(id: string): void;
  onSaved(id: string, stored: boolean): void;
  onFinished(id: string): void;
}

/**
 * Save through the step-up with the revision the form read (MP-RT-03). After a good save the provider is read again;
 * a `stored` one then waits for its key (`offer`), which is typed in `ApiKeyForm` and never passes through here (MPR12).
 * A `conflict` reads again, keeps the draft and says so.
 */
export function useProviderSave(input: UseProviderSaveInput) {
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<IssueTargets>(NO_ISSUES);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [offer, setOffer] = useState<string | null>(null);
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  // Another provider was opened in this form: what the last one left behind is not this one's.
  const [scope, setScope] = useState(input.targetKey);
  if (scope !== input.targetKey) {
    setScope(input.targetKey);
    setOffer(null);
    setConflict(false);
    setIssues(NO_ISSUES);
    setFailure(null);
  }

  const save = () => {
    if (busy || input.problems.length > 0 || !input.ready) return;
    setBusy(true);
    setIssues(NO_ISSUES);
    setFailure(null);
    setConflict(false);
    const provider = toInput(input.draft);
    const create = !input.editing;
    const baseRevision = input.revision;
    const started = input.targetKey;
    const here = () => latest.current.targetKey === started;
    input
      .stepUp((commandId) =>
        providerRpc().call(
          "models.provider.save",
          { mode: create ? "create" : "update", id: provider.id, provider, baseRevision },
          { commandId },
        ),
      )
      .then(
        async (result) => {
          if (result === null) return;
          if ("code" in result) {
            if (here()) setIssues(issueTargets(result.issues));
            return;
          }
          const stored = provider.auth.kind === "stored";
          if (!here()) {
            // The owner moved on while the step-up ran: the list learns of the save, this target's state stays.
            latest.current.onSaved(provider.id, stored);
            return;
          }
          if (create) latest.current.onCreated(provider.id);
          const reloaded = await latest.current.reload(provider.id, "saved");
          latest.current.onSaved(provider.id, stored);
          if (!here()) return;
          if (reloaded !== null) setFailure(reloaded);
          if (stored) setOffer(provider.id);
          else latest.current.onFinished(provider.id);
        },
        async (error: unknown) => {
          const code = failureCode(error);
          if (!here()) return;
          if (code !== "conflict") {
            setFailure(code);
            return;
          }
          setConflict(true);
          const reloaded = await latest.current.reload(create ? undefined : provider.id, "conflict");
          if (reloaded !== null && here()) setFailure(reloaded);
        },
      )
      // A reload or a callback that threw: the save itself is settled, so say that something failed, never nothing.
      .catch((error: unknown) => setFailure(failureCode(error)))
      .finally(() => setBusy(false));
  };

  return {
    save,
    busy,
    issues,
    failure,
    conflict,
    offer,
    /** An edit clears what the last attempt said; the conflict notice stays until the next attempt. */
    clear() {
      setIssues(NO_ISSUES);
      setFailure(null);
    },
    clearConflict: () => setConflict(false),
    finish() {
      if (offer === null) return;
      setOffer(null);
      latest.current.onFinished(offer);
    },
  };
}
