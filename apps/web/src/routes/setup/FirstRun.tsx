import { SetupStepper } from "../../features/auth/SetupStepper.tsx";
import { SetupModels } from "./SetupModels.tsx";

/** The first-run page, in a chunk of its own: it is shown once in the life of an install. */
export function FirstRun({ onDone, onAccountCreated }: { onDone(): void; onAccountCreated(): void }) {
  return <SetupStepper onDone={onDone} onAccountCreated={onAccountCreated} models={SetupModels} />;
}
