import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { failureCode } from "../failure.ts";
import type { StepUpRunner } from "../step-up.ts";
import type { Preset } from "./presets.ts";
import { type GetResult, providerRpc } from "./provider-rpc.ts";
import { type Draft, draftOf, emptyDraft, type Problem, problems } from "./provider-form.vm.ts";
import { type LoadMode, useProviderSave } from "./use-provider-save.ts";

export type NotEditableReason = Extract<GetResult, { editable: false }>["reason"];
export type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "blocked"; readonly reason: NotEditableReason }
  | { readonly kind: "ready" };

export interface UseProviderFormInput {
  readonly target: { readonly id?: string };
  readonly existingIds: ReadonlySet<string>;
  readonly builtinIds: ReadonlySet<string>;
  readonly stepUp: StepUpRunner;
  onSaved(id: string, stored: boolean): void;
  /** The form has nothing more to ask: no key to add, or the key was added or skipped. */
  onFinished(id: string): void;
  onCommented(blocked: boolean): void;
}

/**
 * The state of one provider form. It opens with `models.provider.get` (`{}` to create, `{ id }` to edit) and keeps the
 * `revision` that answer carried for the save (MP-RT-03). The draft holds no key (MPR12).
 */
export function useProviderForm(input: UseProviderFormInput) {
  const { target, existingIds, builtinIds, stepUp } = input;
  const key = target.id ?? "";
  // A provider this form created is an update from then on; another target forgets it.
  const [created, setCreated] = useState<{ readonly from: string; readonly id: string } | null>(null);
  const id = target.id ?? (created?.from === key ? created.id : undefined);
  const editing = id !== undefined;
  const [answered, setAnswered] = useState<{ readonly for: string; readonly phase: Phase } | null>(null);
  // The answer of another target (Edit A, then Edit B) is not this form's: B shows loading until its own get returns.
  const phase: Phase = answered?.for === key ? answered.phase : { kind: "loading" };
  const [loads, setLoads] = useState(0);
  const [draft, setDraftState] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState("");
  const [revision, setRevision] = useState("");
  const [fileVersion, setFileVersion] = useState<Draft | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // What auth.json holds (ids and a yes, never a value): the add form's ids, and the edited provider's own flag.
  const [storedKeys, setStoredKeys] = useState<ReadonlySet<string>>(new Set());
  const [keyStored, setKeyStored] = useState(false);
  const [picked, setPicked] = useState(false);
  const latest = useRef({ ...input, id });
  useEffect(() => {
    latest.current = { ...input, id };
  });
  const answers = useRef(0);
  // Whether the newest answer said the provider is no longer in the file (a remove that half worked, MPR-C5).
  const gone = useRef(false);

  /** One `models.provider.get`; the newest call wins. Resolves to the failure code, or null. */
  const load = useCallback(
    (loadId: string | undefined, mode: LoadMode | "open"): Promise<string | null> => {
      const mine = ++answers.current;
      const settled = (next: Phase) => setAnswered({ for: key, phase: next });
      return providerRpc()
        .call("models.provider.get", loadId === undefined ? {} : { id: loadId })
        .then(
          (answer) => {
            if (mine !== answers.current) return null;
            gone.current = loadId !== undefined && !answer.editable && answer.reason === "not_in_file";
            setRevision(answer.revision);
            if (answer.editable) {
              const loaded = draftOf(answer.provider);
              setAdvanced(answer.advanced);
              setKeyStored(answer.keyStored === true);
              if (mode === "conflict") setFileVersion(loaded);
              else {
                setDraftState(loaded);
                setBaseline(JSON.stringify(loaded));
                setFileVersion(null);
              }
              settled({ kind: "ready" });
              return null;
            }
            if (loadId === undefined) {
              setStoredKeys(new Set(answer.storedKeys ?? []));
              // A form opened to create gets `not_in_file` and a revision; a commented file blocks it (MPR11).
              latest.current.onCommented(answer.reason === "needs_raw_editor");
              if (answer.reason === "not_in_file") {
                if (mode === "open") {
                  setDraftState(emptyDraft());
                  setBaseline(JSON.stringify(emptyDraft()));
                }
                settled({ kind: "ready" });
                return null;
              }
            }
            settled({ kind: "blocked", reason: answer.reason });
            return null;
          },
          (failure: unknown) => {
            if (mine !== answers.current) return null;
            const code = failureCode(failure);
            // After a save or a conflict the draft stays on screen: the code is shown beside it, not instead of it.
            if (mode === "open") settled({ kind: "failed", code });
            return code;
          },
        );
    },
    [key],
  );

  useEffect(() => {
    void load(latest.current.id, "open");
    return () => {
      answers.current += 1;
    };
  }, [loads, target.id, load]);

  const list: Problem[] = useMemo(
    () => problems(draft, editing ? new Set() : existingIds, builtinIds),
    [draft, editing, existingIds, builtinIds],
  );

  const saving = useProviderSave({
    targetKey: key,
    ready: phase.kind === "ready",
    editing,
    draft,
    problems: list,
    revision,
    stepUp,
    reload: load,
    onCreated: (createdId) => setCreated({ from: key, id: createdId }),
    onSaved: (savedId, stored) => latest.current.onSaved(savedId, stored),
    onFinished: (savedId) => latest.current.onFinished(savedId),
  });

  return {
    phase,
    id,
    editing,
    draft,
    revision,
    setDraft(next: Draft) {
      setDraftState(next);
      saving.clear();
    },
    pickPreset(preset: Preset) {
      setDraftState(emptyDraft(preset));
      setPicked(true);
    },
    step: editing || picked ? ("form" as const) : ("preset" as const),
    advanced,
    keyHeld: editing ? keyStored : storedKeys.has(draft.id.trim()),
    problems: list,
    issues: saving.issues,
    saveFailure: saving.failure,
    conflict: saving.conflict,
    offer: saving.offer,
    finishOffer: saving.finish,
    busy: saving.busy,
    dirty: phase.kind === "ready" && JSON.stringify(draft) !== baseline,
    save: saving.save,
    /** The conflict reload kept the owner's draft; this takes the file's version instead, on request. */
    fileVersion,
    showFileVersion() {
      if (fileVersion === null) return;
      setDraftState(fileVersion);
      setBaseline(JSON.stringify(fileVersion));
      setFileVersion(null);
      saving.clearConflict();
      saving.clear();
    },
    /** `models.provider.get` again for a remove that hit a conflict: the revision moves, nothing else does. */
    reloadRevision: async () => {
      const code = await load(id, "conflict");
      return { code, gone: code === null && gone.current };
    },
    reload() {
      setAnswered(null);
      setLoads((count) => count + 1);
    },
  };
}
