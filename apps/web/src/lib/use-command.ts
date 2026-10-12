import { useEffect, useRef } from "react";
import { registerCommand, type CommandHandler } from "./command-registry.ts";

/** Registers a command handler while mounted and `enabled`; the registry always calls the latest `handler`. */
export function useCommand(id: string, handler: CommandHandler, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => (enabled ? registerCommand(id, () => latest.current()) : undefined), [id, enabled]);
}
