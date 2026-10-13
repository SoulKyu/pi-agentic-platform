import { DEFAULT_POLICY_SETTINGS } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { failureCode, failureText, outcomeUnknown } from "./failure.ts";
import { checkForm, formOf, sameSettings, type FormCheck, type SettingsForm } from "./policy-settings.vm.ts";

export type Notice = "saved" | "conflict" | null;

export interface SettingsFormState {
  readonly ready: boolean;
  readonly form: SettingsForm;
  readonly check: FormCheck;
  readonly busy: boolean;
  readonly notice: Notice;
  /** The text of the last failure (load or save), never silent. */
  readonly error: string | null;
  edit(patch: Partial<SettingsForm>): void;
  save(): void;
  reload(): void;
}

/**
 * The form edits a copy of `policy.getSettings`. Save sends it with the revision that copy was read at (M5R89):
 * a conflict or an unknown outcome re-reads, takes the new revision and keeps the person's edits on screen.
 */
export function useSettingsForm(): SettingsFormState {
  const [form, setForm] = useState<SettingsForm>(() => formOf(DEFAULT_POLICY_SETTINGS));
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const saving = useRef(false);

  useEffect(() => {
    let current = true; // a later load, or an unmount, drops this answer
    getRuntime()
      .rpc.call("policy.getSettings", {})
      .then(
        (answer) => {
          if (!current) return;
          setForm(formOf(answer.value ?? DEFAULT_POLICY_SETTINGS));
          setRevision(answer.revision);
          setError(null);
        },
        (failure: unknown) => {
          if (current) setError(failureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [loads]);

  const check = checkForm(form);

  const save = useCallback(() => {
    const wanted = checkForm(form).settings;
    if (saving.current || revision === null || wanted === null) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const rpc = getRuntime().rpc;
    const attempt = async () => {
      try {
        const done = await rpc.call(
          "policy.setSettings",
          { value: wanted, baseRevision: revision },
          { commandId: rpc.newCommandId() },
        );
        setRevision(done.revision);
        setNotice("saved");
      } catch (failure) {
        if (failureCode(failure) !== "conflict" && !outcomeUnknown(failure)) {
          setError(failureText(failure));
          return;
        }
        // Whatever happened to the write, the stored document is the truth: read it before anything else (R105).
        try {
          const now = await rpc.call("policy.getSettings", {});
          setRevision(now.revision);
          if (failureCode(failure) === "conflict") setNotice("conflict");
          else if (sameSettings(now.value, wanted)) setNotice("saved");
          else setError(failureText(failure));
        } catch (reread) {
          setError(failureText(reread));
        }
      }
    };
    void attempt().finally(() => {
      saving.current = false;
      setBusy(false);
    });
  }, [form, revision]);

  return {
    ready: revision !== null,
    form,
    check,
    busy,
    notice,
    error,
    edit: (patch) => {
      setForm((now) => ({ ...now, ...patch }));
      setNotice(null);
    },
    save,
    reload: () => setLoads((count) => count + 1),
  };
}
