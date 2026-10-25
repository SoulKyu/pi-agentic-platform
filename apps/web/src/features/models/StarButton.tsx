import { Icon, IconStar } from "@pap/ui";

interface StarButtonProps {
  readonly label: string;
  readonly isDefault: boolean;
  readonly disabled: boolean;
  onPress(): void;
}

/** The "make this the default" toggle of a model row: a filled star for the default, an outline otherwise, in a 24 px button. */
export function StarButton({ label, isDefault, disabled, onPress }: StarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isDefault}
      disabled={disabled}
      onClick={onPress}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-transparent transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50 can-hover:hover:bg-surface-2 ${isDefault ? "text-agent" : "text-muted"}`}
    >
      <Icon icon={IconStar} size={14} filled={isDefault} />
    </button>
  );
}
