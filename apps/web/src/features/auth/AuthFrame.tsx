import { Mark, Wordmark } from "@pap/ui";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";

/** The Night Control card shared by the sign-in and setup screens: logo, wordmark, then the title and the form. */
export function AuthFrame({
  title,
  above,
  wide,
  children,
}: {
  readonly title: string;
  /** Between the wordmark and the title: the first-run step list. */
  readonly above?: ReactNode;
  readonly wide?: boolean | undefined;
  readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <main className="flex min-h-full items-center justify-center p-s4">
      <div
        className={`flex w-full ${wide ? "max-w-xl" : "max-w-sm"} flex-col gap-s4 rounded-md border border-border-strong bg-surface p-s5`}
      >
        <div className="flex items-center gap-s3">
          <Mark size={32} />
          <Wordmark name={t("app.name")} tagline={t("app.tagline")} />
        </div>
        {above}
        <h1 tabIndex={-1} className="text-h1 text-fg focus:outline-none">
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}
