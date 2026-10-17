import type { NewLanePrefill } from "../../stores/new-lane-request.ts";
import type { TriggerPrefill } from "../../stores/trigger-prefill.ts";

/** The Settings sections the home links to. */
export type HomeSettingsSection = "automation" | "skills" | "mcp" | "approvals";

/** What a home link opens: the shapes of the workspace's items, so the shell passes them straight through. */
export type HomeTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "lane"; readonly id: string }
  | { readonly kind: "compare"; readonly id: string }
  | { readonly kind: "tasks" }
  | { readonly kind: "files"; readonly root: string }
  | { readonly kind: "terminal"; readonly id: string }
  | { readonly kind: "settings"; readonly section: HomeSettingsSection };

/**
 * Everything the home opens lives in the shell or in another feature, and features never import each other: the shell
 * builds these (`routes/shell/home-actions.ts`) and hands them in.
 */
export interface HomeActions {
  /** The URL of a target, for a link's `href`. */
  href(target: HomeTarget): string;
  /** Opens a target as a tab (the URL names it). */
  open(target: HomeTarget): void;
  /** The ⌘B tree (the phone's Lists), narrowed to the switcher's project; it holds the archived lanes too. */
  openTree(): void;
  openInbox(): void;
  /** ⌘K in transcript-search mode, narrowed to the project when one is given. */
  openSearch(projectId: string | null): void;
  openShortcuts(): void;
  /** The New lane dialog with this prefill; false when the shell could not open it. */
  newLane(prefill: NewLanePrefill): boolean;
  /** The New agent dialog (M11R96); the shell opens the new agent's tab when it is created. */
  newAgent(): void;
  /** A new trigger's editor in this project, its name and prompt filled in. */
  newTrigger(projectId: string, prefill: TriggerPrefill): void;
  /** The Add project dialog; `onAdded` runs with the new project's id once it is added. */
  addProject(onAdded: (projectId: string) => void): void;
}

/** A chord as the shell formats it ("Ctrl" "K" joined by "+"); no keys: no hint. */
export interface HomeChord {
  readonly keys: readonly string[];
  readonly joiner: "" | "+";
}

/** The hints the home shows (a feature cannot read the keybindings: the shell formats them, web.md "Chord as a prop"). */
export interface HomeShortcuts {
  readonly lane: HomeChord;
  readonly search: HomeChord;
  readonly help: HomeChord;
}
