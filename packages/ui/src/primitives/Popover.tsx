import { Popover as Radix } from "radix-ui";
import { cloneElement, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { useIsPhone } from "../media.ts";
import { Dialog } from "./Dialog.tsx";

export interface PopoverProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** The popover's accessible name (the sheet's title on a phone). */
  readonly label: string;
  readonly trigger: ReactElement<{ onClick?: MouseEventHandler }>;
  readonly closeLabel: string;
  readonly children: ReactNode;
}

const CONTENT_CLASSES =
  "z-50 flex max-h-popover min-w-64 max-w-full flex-col overflow-hidden rounded-md border border-border-strong bg-bg-side shadow-overlay animate-overlay-in";

/**
 * A panel anchored to its trigger on desktop, a bottom sheet on phones (the `Menu` pattern). Modal, so that wheel and
 * touch scroll reach a list inside it even when it opens from a modal dialog (MPR27). It is portalled to the body: a
 * dialog's panel clips and transforms, so a popover inside it is cut off and its list cannot scroll. The panel is bounded and clips;
 * it does not scroll itself, the list it holds does.
 */
export function Popover({ open, onOpenChange, label, trigger, closeLabel, children }: PopoverProps) {
  const phone = useIsPhone();
  if (phone) {
    return (
      <>
        {cloneElement(trigger, {
          onClick: (event) => {
            trigger.props.onClick?.(event);
            onOpenChange(true);
          },
        })}
        <Dialog open={open} onOpenChange={onOpenChange} variant="sheet" title={label} closeLabel={closeLabel}>
          {children}
        </Dialog>
      </>
    );
  }
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange} modal>
      <Radix.Trigger asChild>{trigger}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          data-slot="popover"
          aria-label={label}
          align="start"
          sideOffset={4}
          className={CONTENT_CLASSES}
        >
          {children}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
