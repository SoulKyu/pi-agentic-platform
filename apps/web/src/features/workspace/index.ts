export {
  activeTab,
  EMPTY_WORKSPACE,
  itemKey,
  OWNER_SECTIONS,
  sectionFor,
  SETTINGS_SECTIONS,
  sectionsFor,
} from "./model.ts";
export type { ItemRef, SettingsSection, Tab, Workspace } from "./model.ts";
export { isAgentId, isValidId, isValidRoot, itemFromPath, pathOfItem } from "./item-path.ts";
export { SplitView } from "./SplitView.tsx";
export { useWorkspaceStore } from "./workspace-store.ts";
