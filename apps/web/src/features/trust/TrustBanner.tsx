import "./register-banner-catalog.ts";
import { Banner, Button } from "@pap/ui";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { needsTrust, type ProjectTrust } from "./trust.vm.ts";

// One function for the life of the page, so the lazy component is shared.
const loadDialog = () => import("./TrustDialog.tsx").then((module) => ({ default: module.TrustDialog }));

/**
 * "This project has Pi resources pap does not load until you trust it." (M7R109): only when the worker says trust is
 * required and not given. Review opens the dialog, fetched on first use. A decision applies when Pi restarts, so the
 * banner then says that instead of offering Review again; it is per session, so it starts over with another one.
 */
export function TrustBanner({
  sessionId,
  cwd,
  trust,
}: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly trust: ProjectTrust | null;
}) {
  return <SessionTrustBanner key={sessionId} cwd={cwd} trust={trust} />;
}

function SessionTrustBanner({ cwd, trust }: { readonly cwd: string; readonly trust: ProjectTrust | null }) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const [open, setOpen] = useState(false);
  const [decided, setDecided] = useState<boolean | null>(null);
  if (!needsTrust(trust) || cwd === "") return null;
  return (
    <>
      <Banner
        tone="capacity"
        title={t(
          decided === null
            ? "trust.banner.title"
            : decided
              ? "trust.banner.trusted"
              : "trust.banner.untrusted",
        )}
        actions={
          decided === null ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t("trust.banner.review")}
            </Button>
          ) : null
        }
      />
      <LazyPanel
        text={lazyText}
        load={loadDialog}
        open={open}
        props={{
          cwd,
          onClose: () => setOpen(false),
          onDecided: (trusted: boolean) => {
            setDecided(trusted);
            setOpen(false);
          },
        }}
        onFailed={() => setOpen(false)}
      />
    </>
  );
}
