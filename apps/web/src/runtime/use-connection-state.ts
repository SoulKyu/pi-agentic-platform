import { useCallback, useSyncExternalStore } from "react";
import type { Connection, ConnectionState } from "./connection.ts";

export function useConnectionState(connection: Connection): ConnectionState {
  const subscribe = useCallback((onChange: () => void) => connection.onState(onChange), [connection]);
  return useSyncExternalStore(subscribe, () => connection.state);
}
