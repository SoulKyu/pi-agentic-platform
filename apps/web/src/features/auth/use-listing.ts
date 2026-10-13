import { useCallback, useEffect, useState } from "react";
import { failureText } from "./step-up.ts";

/** A list read by RPC. Each load drops the answer of the one before it, and of an unmounted screen. */
export function useListing<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    load().then(
      (answer) => {
        if (!current) return;
        setValue(answer);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(failureText(failure));
      },
    );
    return () => {
      current = false;
    };
    // `load` is a fresh closure on every render; a load is asked for by `reload` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is the only trigger, see above
  }, [loads]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return { value, error, reload };
}
