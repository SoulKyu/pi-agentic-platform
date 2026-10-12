import { Mark, Wordmark } from "@pap/ui";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";

/** The Night Control card shared by the sign-in and setup screens: logo, wordmark, then the title and the form. */
export function AuthFrame({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const t = useT();
  return (
    <main className="flex min-h-full items-center justify-center p-s4">
      <div className="flex w-full max-w-sm flex-col gap-s4 rounded-md border border-border-strong bg-surface p-s5">
        <div className="flex items-center gap-s3">
          <Mark size={32} />
          <Wordmark name={t("app.name")} tagline={t("app.tagline")} />
        </div>
        <h1 className="text-h1 text-fg">{title}</h1>
        {children}
      </div>
    </main>
  );
}
