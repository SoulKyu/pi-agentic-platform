import {
  type Activity,
  IDLE_ACTIVITY,
  type Panel,
  type SessionStreamEvent,
  type StatusEntry,
  UI_LIMITS,
  type Widget,
} from "@pap/contracts";
import type { SessionView } from "./session-reducer.ts";

/** What an extension decorates the session with; the part of `SessionView` this file owns. */
export interface UiState {
  readonly statuses: readonly StatusEntry[];
  readonly widgets: readonly Widget[];
  readonly title: string | null;
  readonly panels: readonly Panel[];
  /** A composer instruction: `seq` counts the events, so the composer applies each once, even for the same text. */
  readonly editorText: { readonly text: string; readonly seq: number } | null;
  /** The session is compacting, or Pi is retrying after an error (the composer waits while it compacts, M2R89). */
  readonly activity: Activity;
}

export const EMPTY_UI: UiState = {
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  editorText: null,
  activity: IDLE_ACTIVITY,
};

/** Replaces the entry with this key in place, else appends it unless `limit` entries are held (the contract's bound). */
function upsert<T>(list: readonly T[], keyOf: (item: T) => string, item: T, limit: number): readonly T[] {
  const index = list.findIndex((existing) => keyOf(existing) === keyOf(item));
  if (index >= 0) return list.with(index, item);
  return list.length >= limit ? list : [...list, item];
}

/** The snapshot's decorations; the editor text keeps counting so a seq is never reused. */
export function uiOfSnapshot(
  event: Extract<SessionStreamEvent, { kind: "snapshot" }>,
  view: SessionView,
): UiState {
  return {
    statuses: event.statuses,
    widgets: event.widgets,
    title: event.title,
    panels: event.panels,
    editorText: view.editorText,
    activity: event.activity,
  };
}

/** A cold session has no worker, so nothing it showed is still true. */
export const clearedUi = (view: SessionView): SessionView => ({
  ...view,
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  activity: IDLE_ACTIVITY,
});

/** The view after a decoration event; `null` for any other kind of event. */
export function reduceUi(view: SessionView, event: SessionStreamEvent): SessionView | null {
  switch (event.kind) {
    case "status_bar":
      return {
        ...view,
        statuses:
          event.text === null
            ? view.statuses.filter((status) => status.key !== event.key)
            : upsert(view.statuses, (s) => s.key, { key: event.key, text: event.text }, UI_LIMITS.statuses),
      };
    case "widget":
      return {
        ...view,
        widgets:
          event.widget === null
            ? view.widgets.filter((widget) => widget.key !== event.key)
            : upsert(view.widgets, (w) => w.key, event.widget, UI_LIMITS.widgets),
      };
    case "title":
      return { ...view, title: event.title };
    case "activity":
      return { ...view, activity: event.activity };
    case "editor_text":
      return { ...view, editorText: { text: event.text, seq: (view.editorText?.seq ?? 0) + 1 } };
    case "panel":
      return { ...view, panels: upsert(view.panels, (p) => p.id, event.panel, UI_LIMITS.panels) };
    case "panel_closed": {
      const panels = view.panels.filter((panel) => panel.id !== event.id);
      return panels.length === view.panels.length ? view : { ...view, panels };
    }
    default:
      return null;
  }
}
