import { Toast as Radix } from "radix-ui";
import { useSyncExternalStore } from "react";
import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { Icon } from "./Icon.tsx";

export interface ToastInput {
  readonly message: string;
  readonly tone?: "neutral" | "error";
  /** Undo for a reversible action (DESIGN.md §9.1). */
  readonly action?: { readonly label: string; readonly altText: string; run(): void };
}

interface Entry extends ToastInput {
  readonly id: string;
}

const DURATION_MS = 5000;
/** At most this many toasts are kept; a new one beyond it drops the oldest. */
const MAX_TOASTS = 3;
let entries: readonly Entry[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const emit = (next: readonly Entry[]) => {
  entries = next;
  for (const listener of [...listeners]) listener();
};

export function toast(input: ToastInput): string {
  const id = `t${++counter}`;
  emit([...entries, { ...input, id }].slice(-MAX_TOASTS));
  return id;
}

export function dismissToast(id: string): void {
  emit(entries.filter((entry) => entry.id !== id));
}

/** Module state outlives a test: each test starts from no toast (not exported from the package index). */
export function resetToastsForTests(): void {
  emit([]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const TOAST_TONES = { neutral: "border-border-strong", error: "border-err" } as const;

/** Bottom right on desktop, bottom on phones (above the bottom nav: the shell sets --toast-bottom). */
export function Toaster({
  closeLabel,
  regionLabel,
}: {
  readonly closeLabel: string;
  /** The name of the notifications region, translated by the app (Radix would announce its English default). */
  readonly regionLabel: string;
}) {
  const shown = useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );
  return (
    <Radix.Provider duration={DURATION_MS} swipeDirection="right">
      {shown.map((entry) => (
        <Radix.Root
          key={entry.id}
          onOpenChange={(open) => {
            if (!open) dismissToast(entry.id);
          }}
          data-slot="toast"
          className={cn(
            "flex items-center gap-s2 rounded-md border bg-bg-side px-s3 py-s2 text-ui text-fg shadow-overlay animate-overlay-in",
            TOAST_TONES[entry.tone ?? "neutral"],
          )}
        >
          <Radix.Description className="min-w-0 flex-1">{entry.message}</Radix.Description>
          {entry.action ? (
            <Radix.Action
              altText={entry.action.altText}
              onClick={entry.action.run}
              className="label-hud text-you rounded-sm px-s1 focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              {entry.action.label}
            </Radix.Action>
          ) : null}
          <Radix.Close
            aria-label={closeLabel}
            className="inline-flex size-6 items-center justify-center rounded-sm text-muted focus-ring pointer-coarse:size-11"
          >
            <Icon icon={IconClose} size={14} />
          </Radix.Close>
        </Radix.Root>
      ))}
      <Radix.Viewport
        label={regionLabel}
        data-slot="toast-viewport"
        className="fixed bottom-s4 right-s4 z-50 flex w-96 max-w-full flex-col gap-s2 outline-none max-md:inset-x-s2 max-md:bottom-s2 max-md:w-auto"
      />
    </Radix.Provider>
  );
}
