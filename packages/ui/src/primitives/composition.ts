/**
 * A key that belongs to an input method's composition: `isComposing` in Chrome and Firefox, keyCode 229 in Safari,
 * which reports the composition's last key with it (pw: lib/stacked-dialog.ts). Such a key is never a shortcut,
 * never a submit and never closes a dialog.
 */
export function cancelsComposition(event: {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
