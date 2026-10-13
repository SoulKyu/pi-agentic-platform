import { DropdownMenu } from "radix-ui";
import { cloneElement, useState, type MouseEventHandler, type ReactElement } from "react";
import { cn } from "../cn.ts";
import { useIsPhone } from "../media.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly tone?: "danger";
  readonly disabled?: boolean;
  onSelect(): void;
};

export interface MenuProps {
  /** The menu's accessible name (the sheet's title on a phone). */
  readonly label: string;
  readonly trigger: ReactElement<{ onClick?: MouseEventHandler }>;
  readonly items: readonly MenuItem[];
  readonly closeLabel: string;
  /** Mounted on the press that asks for it, so it starts open. */
  readonly defaultOpen?: boolean;
  /** Called when the menu (or the phone sheet) opens or closes, whoever caused it. */
  onOpenChange?(open: boolean): void;
}

const CONTENT_CLASSES =
  "z-50 max-h-app min-w-48 overflow-y-auto rounded-md border border-border-strong bg-bg-side p-s1 shadow-overlay animate-overlay-in";
const ITEM_CLASSES =
  "flex h-control items-center rounded-sm px-s2 text-ui outline-none data-highlighted:bg-surface-2 data-disabled:opacity-50 pointer-coarse:min-h-11";

/** A dropdown on desktop, a bottom sheet of buttons on phones (DESIGN.md §8). */
export function Menu({ label, trigger, items, closeLabel, defaultOpen, onOpenChange }: MenuProps) {
  const phone = useIsPhone();
  const [sheetOpen, setSheet] = useState(defaultOpen === true);
  const setSheetOpen = (open: boolean) => {
    setSheet(open);
    onOpenChange?.(open);
  };
  if (phone) {
    return (
      <>
        {cloneElement(trigger, {
          onClick: (event) => {
            trigger.props.onClick?.(event);
            setSheetOpen(true);
          },
        })}
        <Dialog
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          variant="sheet"
          title={label}
          closeLabel={closeLabel}
        >
          <div className="flex flex-col gap-s1 p-s2">
            {items.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                disabled={item.disabled === true}
                onClick={() => {
                  setSheetOpen(false);
                  item.onSelect();
                }}
              >
                <span className={cn("w-full text-left", item.tone === "danger" ? "text-err" : undefined)}>
                  {item.label}
                </span>
              </Button>
            ))}
          </div>
        </Dialog>
      </>
    );
  }
  return (
    <DropdownMenu.Root defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={label} align="end" sideOffset={4} className={CONTENT_CLASSES}>
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              disabled={item.disabled === true}
              onSelect={item.onSelect}
              className={cn(ITEM_CLASSES, item.tone === "danger" ? "text-err" : "text-fg")}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
