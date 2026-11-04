import type { OverviewBox, OverviewSnapshot } from "@pap/contracts";
import type { ReactNode } from "react";

/** What the route layer gives the pane: features never import each other, so every way out is a callback. */
export interface OverviewCallbacks {
  openAgent(id: string): void;
  openProject(id: string): void;
  openSession(id: string): void;
  openTask(id: string): void;
  revealInbox(itemId: string): void;
  openHealth(): void;
  newAgent(): void;
  newProject(): void;
  /** The card's buttons (START, STOP): the route layer owns the actions. */
  actions?(box: OverviewBox, capacity: OverviewSnapshot["capacity"]): ReactNode;
  /** An agent's avatar, drawn by the agents feature; without it the card shows a glyph. */
  renderAvatar?(agentId: string): ReactNode;
}
