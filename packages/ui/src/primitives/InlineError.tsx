import type { ReactNode } from "react";
import { cn } from "../cn.ts";
import { IconWarning } from "../icons.ts";
import { CodeText } from "./CodeText.tsx";
import { Icon } from "./Icon.tsx";

export interface InlineErrorProps {
  readonly tone?: "err" | "attn";
  /** `action`: the result of the person's last action (alert). `background`: anything else (polite status). */
  readonly announce: "action" | "background";
  readonly id?: string;
  readonly children: ReactNode;
}

/** DESIGN.md §11: red when something broke, with the warning icon and words. Pink only when the person must answer. */
export function InlineError({ tone, announce, id, children }: InlineErrorProps) {
  return (
    <p
      data-slot="inline-error"
      id={id}
      role={announce === "action" ? "alert" : "status"}
      className={cn("flex items-start gap-s1 text-ui", tone === "attn" ? "text-attn" : "text-err")}
    >
      <span className="shrink-0">
        <Icon icon={IconWarning} size={14} />
      </span>
      <span className="min-w-0">
        {typeof children === "string" ? <CodeText text={children} /> : children}
      </span>
    </p>
  );
}
