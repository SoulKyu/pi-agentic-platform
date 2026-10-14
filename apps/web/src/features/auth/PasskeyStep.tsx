import { Button } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { AddPasskey } from "./AddPasskey.tsx";
import { fetchAuthStatus } from "./auth-api.ts";
import { AuthFrame } from "./AuthFrame.tsx";
import { passkeysUsable } from "./passkey-support.ts";
import type { ReactNode } from "react";

/** Step 2: one passkey for this device, or Skip (M7R126). Never blocks: Settings › Access adds one later. */
export function PasskeyStep({
  steps,
  onNext,
  onSignedOut,
}: {
  readonly steps: ReactNode;
  onNext(): void;
  onSignedOut(): void;
}) {
  const t = useT();
  // null: the server has not said yet.
  const [usable, setUsable] = useState<boolean | null>(null);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    let current = true;
    fetchAuthStatus().then(
      (status) => current && setUsable(passkeysUsable(status.passkeysAvailable)),
      () => current && setUsable(false),
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <AuthFrame title={t("firstRun.passkey.title")} above={steps}>
      <p className="text-ui text-muted">
        {usable === false ? t("firstRun.passkey.unavailable") : t("firstRun.passkey.intro")}
      </p>
      {added ? (
        <p role="status" className="text-ui text-fg">
          {t("firstRun.passkey.added")}
        </p>
      ) : usable ? (
        <AddPasskey onAdded={() => setAdded(true)} onSignedOut={onSignedOut} />
      ) : null}
      <div>
        <Button variant={added ? "primary" : "secondary"} onClick={onNext}>
          {added || usable === false ? t("firstRun.continue") : t("firstRun.skip")}
        </Button>
      </div>
    </AuthFrame>
  );
}
