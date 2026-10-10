import type { ToolCategory } from "@pap/contracts";

const READ = new Set(["read", "grep", "find", "ls"]);
const EDIT = new Set(["edit", "write"]);
const EXEC = new Set(["bash", "powershell"]);
const NETWORK = new Set(["web_fetch", "web_search", "fetch"]);
const MAX_PAYLOAD = 4000;

export function toolCategory(toolName: string): ToolCategory {
  if (READ.has(toolName)) return "read";
  if (EDIT.has(toolName)) return "edit";
  if (EXEC.has(toolName)) return "exec";
  if (NETWORK.has(toolName)) return "network";
  return "unknown";
}

export function describeCall(toolName: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  const payload = EXEC.has(toolName) && typeof command === "string" ? command : JSON.stringify(input ?? {});
  const shown =
    payload.length > MAX_PAYLOAD
      ? `${payload.slice(0, MAX_PAYLOAD)}… (${payload.length} characters)`
      : payload;
  return `${toolName}: ${shown}`;
}
