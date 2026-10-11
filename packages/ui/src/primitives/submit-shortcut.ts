import { cancelsComposition } from "./composition.ts";

/** Ctrl/Cmd+Enter submits; the Enter that confirms an input-method composition never does. */
export function isSubmitShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean; readonly keyCode?: number };
}): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !cancelsComposition(event.nativeEvent);
}
