import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useProjectSettingsRequest } from "../../stores/project-settings-request.ts";

const loadSettings = () =>
  import("../../features/projects/ProjectSettings.tsx").then((m) => ({ default: m.ProjectSettings }));

const close = () => useProjectSettingsRequest.getState().close();

/** Owns the box project's settings dialog: fetched on first open, mounted only while open (the New project dialog's way). */
export function ProjectSettingsHost() {
  const lazyText = useLazyFailureText();
  const projectId = useProjectSettingsRequest((state) => state.projectId);
  return (
    <LazyPanel
      text={lazyText}
      load={loadSettings}
      open={projectId !== null}
      props={{ projectId: projectId ?? "", onClose: close }}
      onFailed={close}
    />
  );
}
