import { LoginStreamEvent, type LoginMethod } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { codeText, failureCode, failureText } from "./failure.ts";
import { applyLoginStreamEvent, EMPTY_FLOW, flowDone, type FlowView } from "./models.vm.ts";
import type { StepUpRunner } from "./step-up.ts";

/** Where the live flow's id is kept so a reload can follow it again (MC31). */
export const LOGIN_STORAGE_KEY = "pap.models.login";

interface Stored {
  readonly provider: string;
  readonly flowId: string;
}

function readStored(): Stored | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(LOGIN_STORAGE_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { provider, flowId } = value as Record<string, unknown>;
    if (typeof provider !== "string" || provider === "" || provider.length > 128) return null;
    if (typeof flowId !== "string" || flowId === "" || flowId.length > 64) return null;
    return { provider, flowId };
  } catch {
    // Nothing stored, or storage refused: there is no flow to follow again.
    return null;
  }
}

function writeStored(value: Stored | null): void {
  try {
    if (value === null) sessionStorage.removeItem(LOGIN_STORAGE_KEY);
    else sessionStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A browser that refuses storage only loses the follow-up after a reload; the flow itself runs on.
  }
}

export interface LoginFlow {
  readonly provider: string;
  readonly flowId: string;
  readonly view: FlowView;
  /** Why the flow cannot be followed or answered any more; Cancel stays available. */
  readonly error: string | null;
}

interface Deps {
  readonly stepUp: StepUpRunner;
  /** The flow ended, was cancelled or is gone: read the providers again. */
  onFinished(): void;
}

/**
 * The one sign-in flow of this page: starts it (behind the password step-up), follows its `login` stream, answers its
 * prompts and cancels it. `stuck` names a provider whose `models.login` answered `conflict`: a flow is live there
 * whose id this page lost, which `cancelProvider` (`models.cancelLogin`) can stop. `models.loginCancel` stops a
 * flow this page holds the id of: two different methods, kept apart on purpose.
 */
export function useLoginFlow({ stepUp, onFinished }: Deps) {
  const [flow, setFlow] = useState<LoginFlow | null>(() => {
    const stored = readStored();
    return stored && { ...stored, view: EMPTY_FLOW, error: null };
  });
  const [starting, setStarting] = useState<string | null>(null);
  const [stuck, setStuck] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flowId = flow?.flowId ?? null;
  const finished = flow?.view.done != null;

  useEffect(() => {
    if (flowId === null || finished) return;
    return getRuntime().subscriptions.subscribe(
      "login",
      flowId,
      (event) => {
        const parsed = LoginStreamEvent.safeParse(event);
        if (!parsed.success) return;
        if (flowDone([parsed.data])) {
          writeStored(null);
          onFinished();
        }
        setFlow((previous) =>
          previous?.flowId === flowId
            ? { ...previous, view: applyLoginStreamEvent(previous.view, parsed.data) }
            : previous,
        );
      },
      (code) => {
        if (code === "not_found") {
          // Over, or not this caller's: nothing to follow. The list says whether it succeeded.
          writeStored(null);
          setFlow(null);
          setNotice(t("settingsModels.flow.gone"));
          onFinished();
          return;
        }
        setFlow((previous) =>
          previous?.flowId === flowId ? { ...previous, error: codeText(code) } : previous,
        );
      },
    );
    // `onFinished` is the host's stable reload; the stream is followed again only when the flow changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [flowId, finished]);

  const start = useCallback(
    async (provider: string, method: LoginMethod) => {
      const rpc = getRuntime().rpc;
      setStarting(provider);
      setStuck(null);
      setNotice(null);
      try {
        const started = await stepUp((commandId) =>
          rpc.call("models.login", { provider, method }, { commandId }),
        );
        if (started === null) return;
        writeStored({ provider, flowId: started.flowId });
        setFlow({ provider, flowId: started.flowId, view: EMPTY_FLOW, error: null });
      } catch (failure) {
        if (failureCode(failure) === "conflict") setStuck(provider);
        else setNotice(failureText(failure));
      } finally {
        setStarting(null);
      }
    },
    [stepUp],
  );

  const end = useCallback(() => {
    writeStored(null);
    setFlow(null);
    setStuck(null);
    onFinished();
  }, [onFinished]);

  const answer = useCallback(
    async (promptId: string, value: string) => {
      if (flowId === null) return;
      try {
        const rpc = getRuntime().rpc;
        await rpc.call("models.loginAnswer", { flowId, promptId, value }, { commandId: rpc.newCommandId() });
        setFlow((previous) =>
          previous?.flowId === flowId && previous.view.prompt?.promptId === promptId
            ? { ...previous, view: { ...previous.view, prompt: null }, error: null }
            : previous,
        );
      } catch (failure) {
        setFlow((previous) =>
          previous?.flowId === flowId ? { ...previous, error: failureText(failure) } : previous,
        );
      }
    },
    [flowId],
  );

  /** Stops the flow this page holds the id of. A flow already gone counts as stopped. */
  const cancel = useCallback(async () => {
    if (flowId === null) return;
    try {
      const rpc = getRuntime().rpc;
      await rpc.call("models.loginCancel", { flowId }, { commandId: rpc.newCommandId() });
    } catch (failure) {
      if (failureCode(failure) !== "not_found") {
        setNotice(failureText(failure));
        return;
      }
    }
    end();
  }, [flowId, end]);

  /** Stops the caller's own live flow for a provider whose flow id this page lost. */
  const cancelProvider = useCallback(
    async (provider: string) => {
      try {
        const rpc = getRuntime().rpc;
        await rpc.call("models.cancelLogin", { provider }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        if (failureCode(failure) !== "not_found") {
          setNotice(failureText(failure));
          return;
        }
      }
      end();
    },
    [end],
  );

  const dismiss = useCallback(() => {
    setFlow(null);
    setNotice(null);
  }, []);

  return { flow, starting, stuck, notice, start, answer, cancel, cancelProvider, dismiss };
}
