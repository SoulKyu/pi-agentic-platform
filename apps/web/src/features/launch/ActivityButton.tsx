import { Icon, IconHourglass, Tooltip } from "@pap/ui";
import { useState, type ButtonHTMLAttributes } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import type { Where } from "./ActivityList.tsx";
import { useActivityCount } from "./activity.ts";
import { useLaunchWords } from "./use-stage.ts";

const loadList = () => import("./ActivityList.tsx").then((module) => ({ default: module.ActivityList }));

function Trigger({
  label,
  count,
  ...rest
}: { readonly label: string; readonly count: number } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "children" | "aria-label"
>) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-slot="activity-button"
        aria-label={label}
        className="inline-flex h-control min-w-control shrink-0 items-center justify-center gap-s1 rounded-sm border border-transparent px-s1 text-muted transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 can-hover:hover:bg-surface-2 can-hover:hover:text-fg"
        {...rest}
      >
        <Icon icon={IconHourglass} size={16} />
        <span aria-hidden className="font-mono text-label tabular-nums">
          {count}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * "{count} in progress" in the rail and the phone's top bar: nothing when nothing runs. The count is a number from the
 * stores; the words and the list are fetched when something first runs and when the button is first pressed.
 */
export function ActivityButton({ where }: { readonly where: Where }) {
  const t = useT();
  const text = useLazyFailureText();
  const count = useActivityCount();
  const ready = useLaunchWords(count > 0);
  const { Lazy, attempt, retry } = useRetryableLazy(loadList);
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState(false);
  if (count === 0 || !ready) return null;
  const label = t("launch.activity", { count });
  const plain = (
    <Trigger
      label={label}
      count={count}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        if (asked) return;
        setAsked(true);
        setOpen(true);
      }}
    />
  );
  return asked ? (
    <LazyBoundary
      resetKey={attempt}
      fallback={plain}
      onError={(error) => {
        setAsked(false);
        setOpen(false);
        retry();
        notifyLazyFailure(error, text);
      }}
    >
      <Lazy
        where={where}
        open={open}
        onOpenChange={setOpen}
        label={label}
        closeLabel={t("ui.close")}
        trigger={plain}
      />
    </LazyBoundary>
  ) : (
    plain
  );
}
