import {
  cloneElement,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

type Popup = typeof import("./TooltipPopup.tsx").TooltipPopup;

// The Radix tooltip stack is not needed at first paint: it loads on the first hover or focus of any tooltip.
let loaded: Popup | null = null;
let loading: Promise<void> | null = null;
function loadPopup(): Promise<void> {
  loading ??= import("./TooltipPopup.tsx").then(
    (module) => {
      loaded = module.TooltipPopup;
    },
    () => {
      loading = null; // a tooltip is decoration: the control keeps its aria-label; the next hover tries again
    },
  );
  return loading;
}

/** Each tooltip carries its own Radix provider, so this one keeps the root call site and adds nothing. */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

export interface TooltipProps {
  /** Names the control. A tooltip never teaches or warns (Orca STYLEGUIDE). */
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly shortcutJoiner?: "" | "+";
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly children: ReactElement;
}

interface TriggerProps {
  onPointerEnter?(event: PointerEvent<HTMLElement>): void;
  onFocus?(event: FocusEvent<HTMLElement>): void;
}

/**
 * The bare control until it is first hovered or focused; then the Radix tooltip mounts NEXT TO it and anchors to
 * the control's own node. The control is never wrapped or re-created, so a press that started before the popup
 * chunk arrived still ends on the same element and its click is not lost.
 */
export function Tooltip({ label, shortcut, shortcutJoiner, side, children }: TooltipProps) {
  const [Popup, setPopup] = useState<Popup | null>(() => loaded);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const own = children.props as TriggerProps;
  const arm = (target: HTMLElement) => {
    if (anchor !== null) return;
    void loadPopup().then(() => {
      if (loaded === null) return;
      setPopup(() => loaded);
      setAnchor(target);
    });
  };
  const bare = cloneElement(children as ReactElement<TriggerProps>, {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      arm(event.currentTarget);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      arm(event.currentTarget);
    },
  });
  return (
    <>
      {bare}
      {Popup && anchor ? (
        <Popup
          anchor={anchor}
          label={label}
          shortcut={shortcut}
          shortcutJoiner={shortcutJoiner}
          side={side}
        />
      ) : null}
    </>
  );
}
