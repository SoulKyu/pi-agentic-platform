import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";

const loadDialog = () => import("../../features/inbox/SecretDialog.tsx");

/**
 * Mounts the secret dialog (M11R130) while a request is open for it: from an Inbox row or from the agent tab's request
 * card. The chunk is fetched on first open. A chunk that cannot load closes the dialog.
 */
export function SecretDialogHost() {
  const lazyText = useLazyFailureText();
  const open = useSecretDialog((state) => state.requestId !== null);
  return (
    <LazyPanel
      text={lazyText}
      load={loadDialog}
      open={open}
      props={{}}
      onFailed={() => useSecretDialog.getState().close()}
    />
  );
}
