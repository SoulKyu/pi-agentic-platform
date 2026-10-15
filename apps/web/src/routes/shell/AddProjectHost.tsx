import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { useCurrentProject } from "../../stores/current-project.ts";

const loadDialog = () =>
  import("../../features/projects/AddProjectDialog.tsx").then((m) => ({ default: m.AddProjectDialog }));

const close = () => useAddProjectRequest.getState().close();

/**
 * Owns the Add project dialog (decision 85): the chip menu and the home's picker ask for it through the request store.
 * Fetched on first open, mounted only while open. On Add the chip switches to the project, then the asker goes on.
 */
export function AddProjectHost() {
  const lazyText = useLazyFailureText();
  const open = useAddProjectRequest((state) => state.open);
  return (
    <LazyPanel
      text={lazyText}
      load={loadDialog}
      open={open}
      props={{
        onClose: close,
        onAdded: (projectId: string) => {
          const { onAdded } = useAddProjectRequest.getState();
          close();
          useCurrentProject.getState().choose(projectId);
          onAdded?.(projectId);
        },
      }}
      onFailed={close}
    />
  );
}
