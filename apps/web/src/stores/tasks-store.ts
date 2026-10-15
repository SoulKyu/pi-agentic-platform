import { create } from "zustand";
import { EMPTY_TASKS, reduceTasks, type TasksView } from "./tasks-reducer.ts";

interface TasksStoreState {
  readonly view: TasksView;
  apply(event: unknown): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The owner's board (the `tasks` stream). The Tasks pane opens the subscription, not the page load. */
export const useTasksStore = create<TasksStoreState>()((set) => ({
  view: EMPTY_TASKS,
  apply: (event) => set((state) => ({ view: reduceTasks(state.view, event) })),
  reset: () => set({ view: EMPTY_TASKS }),
}));
