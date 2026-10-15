import type { ComponentType } from "react";
import "../../i18n/register-automation.ts";
import "../../i18n/register-automation-trigger.ts";
import { TriggerEditor } from "../../features/automation/TriggerEditor.tsx";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";

/** `triggerId` is a trigger's id, or `new:<project id>` for an empty editor. */
export interface TriggerPaneProps {
  readonly triggerId: string;
  readonly prefill?: TriggerPrefill | null;
  onOpenSession(sessionId: string): void;
  onOpenTasks(): void;
  onCreated(id: string): void;
}

/** The trigger editor, its own chunk and catalogs (M10R112). The `data-trigger-pane` marker keeps the chunk out of the initial assets. */
export const TriggerPaneEntry: ComponentType<TriggerPaneProps> = TriggerEditor;
