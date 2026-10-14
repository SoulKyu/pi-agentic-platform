import { useCallback, useRef, useState, type ReactNode } from "react";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";

// The prompt is a dialog of the overlay chunk: it loads on the first password request, never with the shell.
const loadEngine = () => import("./StepUpEngine.tsx").then((module) => ({ default: module.StepUpEngine }));

/**
 * The shell's one password prompt for features that ask through `useStepUpRunner` (MC49). Needs the ShellContext above
 * it. The first request fetches the engine and waits for it; a chunk that fails to load answers as a cancel.
 */
export function StepUpHost({ children }: { readonly children: ReactNode }) {
  const lazyText = useLazyFailureText();
  const [wanted, setWanted] = useState(false);
  const engine = useRef<StepUpRunner | null>(null);
  const waiting = useRef<Array<() => void>>([]);
  const register = useCallback((runner: StepUpRunner | null) => {
    engine.current = runner;
    if (runner !== null) for (const wake of waiting.current.splice(0)) wake();
  }, []);
  const stepUp = useCallback<StepUpRunner>(async (run) => {
    if (engine.current === null) {
      setWanted(true);
      await new Promise<void>((resolve) => waiting.current.push(resolve));
    }
    return engine.current === null ? null : engine.current(run);
  }, []);
  const failed = useCallback(() => {
    setWanted(false);
    for (const wake of waiting.current.splice(0)) wake();
  }, []);
  return (
    <StepUpContext.Provider value={stepUp}>
      {children}
      <LazyPanel text={lazyText} load={loadEngine} open={wanted} props={{ register }} onFailed={failed} />
    </StepUpContext.Provider>
  );
}
