import { useCallback, useRef, useState } from "react";
import { skillsFailureText, type SkillAction } from "./skills.vm.ts";

export interface Notice {
  readonly tone: "error" | "status";
  readonly text: string;
}

/**
 * One write at a time for the whole panel: switches, Remove, Update and both installs wait while one is on its way,
 * and `busy` says so. The lists are read again after every write, whatever its outcome: the list is the truth,
 * never the call (a timeout may have landed, R105).
 */
export function useSkillWrites(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (action: SkillAction, job: () => Promise<Notice | null>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setNotice(null);
      try {
        setNotice(await job());
      } catch (failure) {
        setNotice({ tone: "error", text: skillsFailureText(failure, action) });
      } finally {
        inFlight.current = false;
        setBusy(false);
        reload();
      }
    },
    [reload],
  );
  return { busy, notice, run };
}
