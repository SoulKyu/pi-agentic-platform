import {
  type SessionStreamEvent,
  type StatusEntry,
  type UiRequestRecord,
  UI_LIMITS,
  type Widget,
} from "@pap/contracts";

export interface Decorations {
  /**
   * The client event for a decoration request, rebuilt from the fields the daemon knows and cut to `UI_LIMITS`, with
   * the state it leaves behind. `null`: nothing to publish (a malformed request, or a new key past the limit).
   */
  apply(request: UiRequestRecord): SessionStreamEvent | null;
  statuses(): StatusEntry[];
  widgets(): Widget[];
  title(): string | null;
  clear(): void;
}

const NOTICE_LEVELS = new Set(["warning", "error"]);
const cut = (text: string, max: number): string => text.slice(0, max);

export function createDecorations(): Decorations {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, Widget>();
  let title: string | null = null;

  function setStatus(request: UiRequestRecord): SessionStreamEvent | null {
    const key = request.statusKey;
    if (typeof key !== "string" || key.length === 0 || key.length > UI_LIMITS.statusKey) return null;
    if (typeof request.statusText !== "string") {
      statuses.delete(key);
      return { kind: "status_bar", key, text: null };
    }
    if (!statuses.has(key) && statuses.size >= UI_LIMITS.statuses) return null;
    const text = cut(request.statusText, UI_LIMITS.statusText);
    statuses.set(key, text);
    return { kind: "status_bar", key, text };
  }

  function setWidget(request: UiRequestRecord): SessionStreamEvent | null {
    const key = request.widgetKey;
    if (typeof key !== "string" || key.length === 0 || key.length > UI_LIMITS.widgetKey) return null;
    const lines = request.widgetLines;
    if (lines === undefined || lines === null) {
      widgets.delete(key);
      return { kind: "widget", key, widget: null };
    }
    if (!Array.isArray(lines) || !lines.every((line): line is string => typeof line === "string"))
      return null;
    if (!widgets.has(key) && widgets.size >= UI_LIMITS.widgets) return null;
    const widget: Widget = {
      key,
      lines: lines.slice(0, UI_LIMITS.widgetLines).map((line) => cut(line, UI_LIMITS.widgetLineChars)),
      placement: request.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
    };
    widgets.set(key, widget);
    return { kind: "widget", key, widget };
  }

  return {
    apply(request) {
      switch (request.method) {
        case "setStatus":
          return setStatus(request);
        case "setWidget":
          return setWidget(request);
        case "setTitle":
          if (typeof request.title !== "string") return null;
          title = cut(request.title, UI_LIMITS.title);
          return { kind: "title", title };
        case "set_editor_text":
          // Not stored: it is a one-off instruction for the composer, not state.
          return typeof request.text === "string"
            ? { kind: "editor_text", text: cut(request.text, UI_LIMITS.editorText) }
            : null;
        case "notify": {
          if (typeof request.message !== "string" || request.message.length === 0) return null;
          const level = typeof request.notifyType === "string" && NOTICE_LEVELS.has(request.notifyType);
          return {
            kind: "notice",
            level: level ? (request.notifyType as "warning" | "error") : "info",
            text: cut(request.message, UI_LIMITS.noticeText),
          };
        }
        default:
          return null;
      }
    },
    statuses: () => [...statuses].map(([key, text]) => ({ key, text })),
    widgets: () => [...widgets.values()],
    title: () => title,
    clear() {
      statuses.clear();
      widgets.clear();
      title = null;
    },
  };
}
