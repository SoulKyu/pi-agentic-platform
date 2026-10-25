import { IconButton, IconMore, RunStatusChip, InlineError } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useEffect, useState } from "react";
import { useLazyFailureText, useLocale, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { feedUsage } from "../../stores/usage-feed.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { limitLabel } from "./limit.vm.ts";
import "./register-usage-catalog.ts";
import { useAction } from "./use-action.ts";

/**
 * The quota limit of this session, read from the `usage` stream this component keeps open while the screen shows: a chip
 * "Resets 14:30" (or "Limit reached" without a time) and a menu with Resume now and, while a resume is scheduled, Cancel
 * auto-resume. Nothing at all while the session's latest run is not limited.
 */
export function LimitChip({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const locale = useLocale();
  const lazyText = useLazyFailureText();
  const runtime = getRuntime();
  // When the screen opened: the label only needs to know whether the reset falls on another day.
  const [now] = useState(() => Date.now());
  const limit = useUsageStore((state) => state.view.limits.get(sessionId));
  const resume = useAction();
  const cancel = useAction();
  useEffect(() => feedUsage(runtime.subscriptions), [runtime]);
  if (!limit) return null;

  const call = (method: "usage.resumeNow" | "usage.cancelResume") =>
    runtime.rpc.call(method, { sessionId }, { commandId: runtime.rpc.newCommandId() });
  const label = limitLabel(limit, { locale, now });
  const items: MenuItem[] = [
    {
      id: "resume-now",
      label: t("usage.limit.resumeNow"),
      disabled: resume.busy,
      onSelect: () => void resume.run(() => call("usage.resumeNow")),
    },
    ...(limit.resume === "scheduled"
      ? [
          {
            id: "cancel-resume",
            label: t("usage.limit.cancelResume"),
            disabled: cancel.busy,
            onSelect: () => void cancel.run(() => call("usage.cancelResume")),
          },
        ]
      : []),
  ];
  return (
    <span data-limit-chip className="contents">
      <RunStatusChip
        status="limited"
        label={label.key === "usage.limit.resets" ? t(label.key, { time: label.time }) : t(label.key)}
      />
      <LazyMenu
        label={t("usage.limit.menu")}
        closeLabel={t("ui.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => (
          <IconButton data-limit-menu icon={IconMore} label={t("usage.limit.menu")} onClick={ask} />
        )}
      />
      {[resume.error, cancel.error].map((message) =>
        message === null ? null : (
          <div key={message} className="order-last w-full">
            <InlineError announce="action">{message}</InlineError>
          </div>
        ),
      )}
    </span>
  );
}
