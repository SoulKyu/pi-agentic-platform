import { cancelsComposition, type TextFieldCombobox, type TextFieldProps } from "@pap/ui";
import { useEffect } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from "react";
import { PATH_DRAG_TYPE } from "./drop.ts";

/** What a menu of the composer field gives the one key path (M8R113). M7's `/` and `$` menu has the same shape. */
export interface ComposerMenu {
  readonly open: boolean;
  close(): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  readonly combobox: TextFieldCombobox | null;
  /** The field the menu reads its caret from; the first menu that has one provides the field's ref. */
  readonly fieldRef?: RefObject<HTMLTextAreaElement | null>;
  /** An explorer row dropped on the field (absolute path). */
  dropPath?(path: string): void;
}

export interface AttachmentHandlers {
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onDrop(event: DragEvent<HTMLTextAreaElement>): void;
  onDragOver(event: DragEvent<HTMLTextAreaElement>): void;
}

/**
 * A hook (it closes extra open menus in an effect), called unconditionally on every render of the composer. The composer field's only key, paste and drop path. A key goes to the first open menu and to nobody else; the one
 * `combobox` is that menu's; a menu open after it is closed (one menu at a time). A key of an input-method composition
 * reaches no menu.
 */
export function useComposerFieldProps(
  menus: readonly ComposerMenu[],
  attachments: AttachmentHandlers,
): Pick<TextFieldProps, "inputRef" | "onKeyDown" | "onPaste" | "onDrop" | "onDragOver" | "combobox"> {
  const first = menus.find((menu) => menu.open);
  // One menu at a time: any other that is open closes once this render is committed.
  useEffect(() => {
    for (const menu of menus) if (menu.open && menu !== first) menu.close();
  });
  return {
    inputRef: menus.find((menu) => menu.fieldRef)?.fieldRef,
    combobox: first?.combobox ?? null,
    onKeyDown: (event) => {
      if (cancelsComposition(event.nativeEvent)) return;
      first?.onKeyDown(event);
    },
    onPaste: attachments.onPaste,
    onDragOver: attachments.onDragOver,
    onDrop: (event) => {
      const path = event.dataTransfer.getData(PATH_DRAG_TYPE);
      const taker = path ? menus.find((menu) => menu.dropPath) : undefined;
      if (taker?.dropPath) {
        event.preventDefault();
        taker.dropPath(path);
        return;
      }
      attachments.onDrop(event);
    },
  };
}
