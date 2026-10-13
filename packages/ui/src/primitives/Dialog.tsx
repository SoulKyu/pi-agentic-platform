import { Dialog as Radix, VisuallyHidden } from "radix-ui";
import { useRef, type ReactNode, type RefObject } from "react";
import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { useIsPhone } from "../media.ts";
import { cancelsComposition } from "./composition.ts";
import { IconButton } from "./IconButton.tsx";

export type DialogVariant = "center" | "sheet" | "drawer-left" | "drawer-right" | "palette";

const PANEL_CLASSES =
  "flex flex-col overflow-hidden border border-border-strong bg-bg-side text-fg shadow-overlay animate-overlay-in";
const DIALOG_VARIANTS: Record<DialogVariant, string> = {
  center:
    "fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-app -translate-x-1/2 -translate-y-1/2 rounded-md",
  // pw: the sheet is a layer of the visual viewport's height with the panel at its bottom (iOS keyboard).
  sheet: "fixed inset-x-0 top-0 z-50 flex h-app flex-col justify-end",
  "drawer-left": "fixed inset-y-0 left-0 z-50 h-app w-drawer-tree max-w-full rounded-r-md pl-safe",
  "drawer-right": "fixed inset-y-0 right-0 z-50 h-app w-drawer-inbox max-w-full rounded-l-md pr-safe",
  palette: "fixed left-1/2 top-s6 z-50 w-full max-w-xl max-h-app -translate-x-1/2 rounded-md",
};
const SHEET_PANEL_CLASSES = "max-h-app rounded-t-md border-b-0 pb-safe";

export interface DialogProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly title: string;
  readonly hideTitle?: boolean;
  readonly description?: string;
  readonly variant?: DialogVariant;
  readonly closeLabel: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null>;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  variant,
  closeLabel,
  children,
  footer,
  initialFocus,
}: DialogProps) {
  const phone = useIsPhone();
  const requested = variant ?? "center";
  const shown: DialogVariant =
    phone && (requested === "center" || requested === "palette") ? "sheet" : requested;
  const returnTo = useRef<HTMLElement | null>(null);
  const header = (
    <header className="flex items-center justify-between gap-s2 border-b border-border px-s3 py-s2">
      {hideTitle === true ? (
        <VisuallyHidden.Root asChild>
          <Radix.Title>{title}</Radix.Title>
        </VisuallyHidden.Root>
      ) : (
        <Radix.Title className="text-h2 text-fg">{title}</Radix.Title>
      )}
      <Radix.Close asChild>
        <IconButton icon={IconClose} label={closeLabel} size="sm" />
      </Radix.Close>
    </header>
  );
  const body = (
    <>
      {header}
      {description ? (
        <Radix.Description className="px-s3 pt-s2 text-ui text-muted">{description}</Radix.Description>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? (
        <footer className="flex justify-end gap-s2 border-t border-border px-s3 py-s2">{footer}</footer>
      ) : null}
    </>
  );
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange}>
      <Radix.Portal>
        <Radix.Overlay className="fixed inset-0 z-50 bg-bg/60" />
        <Radix.Content
          data-pap-modal=""
          data-slot="dialog"
          data-variant={shown}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "outline-none",
            DIALOG_VARIANTS[shown],
            shown === "sheet" ? "pointer-events-none" : PANEL_CLASSES,
          )}
          onEscapeKeyDown={(event) => {
            // An inline edit inside the dialog takes this Escape for itself: it cancels the edit, the dialog stays.
            const inEdit =
              event.target instanceof Element && event.target.closest("[data-inline-edit]") !== null;
            if (cancelsComposition(event) || inEdit) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // Without a chosen target the panel itself takes focus: the close button would open its tooltip,
            // and that tooltip would swallow the first Escape.
            const target =
              initialFocus?.current ??
              (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = returnTo.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onClick={(event) => {
            // The sheet's layer is transparent above the panel: a tap there closes, like a tap on the overlay.
            if (shown === "sheet" && event.target === event.currentTarget) onOpenChange(false);
          }}
        >
          {shown === "sheet" ? (
            <div className={cn("pointer-events-auto", PANEL_CLASSES, SHEET_PANEL_CLASSES)}>{body}</div>
          ) : (
            body
          )}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
