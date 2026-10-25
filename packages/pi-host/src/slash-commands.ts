import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MAX_LISTED_COMMANDS, type SessionCommand } from "@pap/contracts/pi-host";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => unknown;
interface Described {
  readonly name: string;
  readonly description?: string | undefined;
  readonly sourceInfo?: { readonly path?: string } | undefined;
}

/** Pi's own `/mcp` extension registers under this path (the M5R24 probe records it). */
const MCP_SOURCE = "builtin:mcp";
const MAX_NAME = 128;
const MAX_DESCRIPTION = 1000;
/** The list as JSON must stay well inside the 1 MiB frame (text is escaped, up to six bytes a character). */
const MAX_LIST_BYTES = 600_000;

function* described(session: AgentSession): Generator<SessionCommand> {
  const shape = (item: Described, source: SessionCommand["source"], name = item.name): SessionCommand => ({
    name,
    description: item.description ? item.description.slice(0, MAX_DESCRIPTION) : null,
    source,
    builtinMcp: source === "extension" && item.sourceInfo?.path === MCP_SOURCE,
  });
  for (const command of session.extensionRunner.getRegisteredCommands())
    yield shape({ ...command, name: command.invocationName }, "extension");
  for (const template of session.promptTemplates) yield shape(template, "prompt");
  for (const skill of session.resourceLoader.getSkills().skills)
    yield shape(skill, "skill", `skill:${skill.name}`);
}

/**
 * The slash commands the session's runtime has, as Pi's own `get_commands` lists them: extension commands, prompt
 * templates and skills (`skill:<name>`, the form Pi expands). The worker answers because extensions, the project's
 * trust and its skills are part of that runtime. Names that cannot be sent over the wire are left out.
 */
export function handleGetCommands(session: AgentSession, command: { id: string }, send: Send): void {
  try {
    const commands: SessionCommand[] = [];
    let truncated = false;
    let bytes = 0;
    for (const listed of described(session)) {
      if (listed.name === "" || listed.name.length > MAX_NAME) continue;
      const size = Buffer.byteLength(JSON.stringify(listed)) + 1;
      if (commands.length >= MAX_LISTED_COMMANDS || bytes + size > MAX_LIST_BYTES) {
        truncated = true;
        break;
      }
      bytes += size;
      commands.push(listed);
    }
    send({
      type: "response",
      id: command.id,
      command: "get_commands",
      success: true,
      data: { commands, truncated },
    });
  } catch (error) {
    send({
      type: "response",
      id: command.id,
      command: "get_commands",
      success: false,
      error: messageOf(error),
    });
  }
}
