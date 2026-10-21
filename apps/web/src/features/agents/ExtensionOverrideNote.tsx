import { useT } from "../../i18n/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";

/**
 * One neutral line when another extension registered a tool name pap provides itself (an intended override, not a
 * failure): it comes from the thread's session notices and is shown once, whatever the count.
 */
export function ExtensionOverrideNote({ sessionId }: { readonly sessionId: string | null }) {
  const t = useT();
  const seen = useSessionStore((state) =>
    sessionId === null
      ? false
      : (state.views[sessionId]?.notices.some((notice) => notice.code === "extension_override") ?? false),
  );
  return seen ? (
    <p data-extension-override className="text-ui text-muted">
      {t("agentStatus.extensionOverride")}
    </p>
  ) : null;
}
