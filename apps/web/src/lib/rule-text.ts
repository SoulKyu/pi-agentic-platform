/** What a listed "always" rule needs to say what it covers (Task 2b). */
export interface RuleCover {
  readonly kind?: "exact" | "prefix" | "tool" | undefined;
  readonly pattern?: readonly string[] | undefined;
}

const invisible = /[\p{Cc}\p{Cf}]/gu;

/**
 * What a prefix or tool rule covers, as the lists show it: `pnpm test …` for a command prefix, `anyInput` (the caller's
 * words) for a whole tool. An exact rule, and a prefix rule whose words were lost, give null: the list shows the label.
 */
export function coverText(rule: RuleCover, anyInput: string): string | null {
  if (rule.kind === "tool") return anyInput;
  if (rule.kind !== "prefix" || !rule.pattern?.length) return null;
  return `${rule.pattern.map((word) => word.replace(invisible, "")).join(" ")} …`;
}
