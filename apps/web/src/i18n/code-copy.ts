import type { MessageKey } from "./index.ts";

/** The only catalog values that keep backticks: the component named renders them as code (`CodeText`). */
export const CODE_COPY_KEYS: Readonly<Partial<Record<MessageKey, "EmptyState" | "Banner" | "InlineError">>> =
  {
    "agentsPhone.noVmPurpose": "EmptyState",
    "boxes.error.sandbox_unavailable": "InlineError",
    "boxes.error.vm_bundle_stale": "InlineError",
    "boxes.error.command_failed": "InlineError",
    "error.sandbox_unavailable": "InlineError",
    "error.vm_bundle_stale": "InlineError",
  };
