import type { ToolCategory } from "@pap/contracts";

const READ = new Set(["read", "grep", "find", "ls"]);
const EDIT = new Set(["edit", "write"]);
export const EXEC_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);
const NETWORK = new Set(["web_fetch", "web_search", "fetch"]);

export function toolCategory(toolName: string): ToolCategory {
  if (READ.has(toolName)) return "read";
  if (EDIT.has(toolName)) return "edit";
  if (EXEC_TOOLS.has(toolName)) return "exec";
  if (NETWORK.has(toolName)) return "network";
  return "unknown";
}
