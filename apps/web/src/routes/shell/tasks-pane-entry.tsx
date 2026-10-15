import type { ComponentType } from "react";
import "../../i18n/register-automation.ts";
import { TasksBoard } from "../../features/automation/TasksBoard.tsx";

/** What the pane renderer gives the board: features never import each other, so a session or a trigger opens through these. */
export interface TasksPaneProps {
  onOpenSession(sessionId: string): void;
  onOpenTrigger(triggerId: string): void;
  onNewTrigger(projectId: string): void;
}

/** The Tasks board, its own chunk and catalog (M10R112). The marker keeps the chunk out of the initial assets. */
export const TasksPaneEntry: ComponentType<TasksPaneProps> = TasksBoard;
