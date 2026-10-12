import { cn } from "../cn.ts";
import { Badge } from "./Badge.tsx";

export type AvatarStyle = "outlined" | "tinted" | "glyph";

const AVATAR_STYLE: Record<AvatarStyle, string> = {
  outlined: "border-agent text-agent",
  tinted: "border-agent bg-agent/10 text-agent",
  glyph: "border-agent-fill bg-agent-fill text-agent-ink",
};
const PRESENCE_TONES = { running: "bg-agent-fill", waiting: "bg-attn-fill", idle: "bg-dim" } as const;

export interface AvatarProps {
  readonly initials: string;
  readonly name: string;
  readonly avatarStyle?: AvatarStyle;
  readonly presence?: keyof typeof PRESENCE_TONES;
  readonly badge?: { readonly count: number; readonly label: string };
}

/** Agent avatar (DESIGN.md §9.1): outlined initials by default, presence dot, count badge. */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function Avatar({ initials, name, avatarStyle, presence, badge }: AvatarProps) {
  const style = avatarStyle ?? "outlined";
  return (
    <span
      data-slot="avatar"
      data-presence={presence}
      role="img"
      aria-label={name}
      className={cn(
        "relative inline-flex size-avatar shrink-0 items-center justify-center rounded-md border font-sans text-label font-bold",
        AVATAR_STYLE[style],
      )}
    >
      <span aria-hidden>{Array.from(initials).slice(0, 2).join("")}</span>
      {presence ? (
        <span
          aria-hidden
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-bg",
            PRESENCE_TONES[presence],
          )}
        />
      ) : null}
      {badge && badge.count > 0 ? (
        <span className="absolute -right-1.5 -top-1.5">
          <Badge count={badge.count} label={badge.label} />
        </span>
      ) : null}
    </span>
  );
}
