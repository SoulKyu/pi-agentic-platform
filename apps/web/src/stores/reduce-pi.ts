import { applyPartial } from "./partial-view.ts";
import { sameContent, toMessageView, withUniqueKey } from "./row-view.ts";
import type { SessionView, ToolView } from "./session-reducer.ts";

export const MAX_TOOL_VIEWS = 200;
const MAX_NOTICES = 20;

export const withNotice = (
  view: SessionView,
  level: string,
  text: string,
  source?: "pap" | "extension",
): SessionView => ({
  ...view,
  notices: [...view.notices, source ? { level, text, source } : { level, text }].slice(-MAX_NOTICES),
});
const MAX_PREVIEW_CHARS = 2000;

const textOf = (partialResult: unknown): string => {
  const content = (partialResult as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("")
    .slice(-MAX_PREVIEW_CHARS);
};

/** At most MAX_TOOL_VIEWS, in insertion order: the oldest finished one goes first, the oldest of all when none has. */
function withTool(tools: ReadonlyMap<string, ToolView>, id: string, tool: ToolView): Map<string, ToolView> {
  const next = new Map(tools);
  next.delete(id);
  if (next.size >= MAX_TOOL_VIEWS) {
    const finished = [...next].find(([, existing]) => existing.status !== "running");
    const oldest = finished?.[0] ?? next.keys().next().value;
    if (oldest !== undefined) next.delete(oldest);
  }
  return next.set(id, tool);
}

const replaceTool = (tools: ReadonlyMap<string, ToolView>, id: string, tool: ToolView) =>
  new Map(tools).set(id, tool);

export function failRunningTools(tools: ReadonlyMap<string, ToolView>): Map<string, ToolView> {
  return new Map(
    [...tools].map(([id, tool]) => [id, tool.status === "running" ? { ...tool, status: "failed" } : tool]),
  );
}

export function reducePi(view: SessionView, event: { type: string } & Record<string, unknown>): SessionView {
  const next: SessionView = { ...view, partial: applyPartial(view.partial, event) };
  switch (event.type) {
    case "message_end": {
      const message = toMessageView(event.message);
      // The snapshot and the live stream can both carry a message: the same one is not added twice.
      const replay = view.messages.some(
        (existing) => existing.ref === message.ref && sameContent(existing, message),
      );
      return {
        ...next,
        messages: replay ? view.messages : [...view.messages, withUniqueKey(view.messages, message)],
      };
    }
    case "tool_execution_start":
      return {
        ...next,
        tools: withTool(view.tools, String(event.toolCallId), {
          name: String(event.toolName ?? "tool"),
          status: "running",
          preview: "",
        }),
      };
    case "tool_execution_update": {
      const id = String(event.toolCallId);
      const current = view.tools.get(id);
      return current
        ? {
            ...next,
            tools: replaceTool(view.tools, id, { ...current, preview: textOf(event.partialResult) }),
          }
        : next;
    }
    case "tool_execution_end": {
      const id = String(event.toolCallId);
      const current = view.tools.get(id);
      return current
        ? {
            ...next,
            tools: replaceTool(view.tools, id, {
              ...current,
              status: event.isError === true ? "failed" : "done",
            }),
          }
        : next;
    }
    case "extension_ui_request":
      return event.method === "notify" && typeof event.message === "string"
        ? withNotice(next, String(event.notifyType ?? "info"), event.message)
        : next;
    default:
      return next.partial === view.partial ? view : next;
  }
}
