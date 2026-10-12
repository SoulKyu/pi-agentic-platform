import type { Dialog, DialogResponse } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useRef, useState } from "react";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import { getRuntime } from "../../../runtime/index.ts";
import { failureText, outcomeUnknown } from "../failure.ts";
import { ApprovalCardFor } from "./ApprovalCardFor.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SelectDialog } from "./SelectDialog.tsx";
import { TextDialog } from "./TextDialog.tsx";

/** An answer whose outcome is unknown (`timeout`, `connection_lost`): offered again with the same command id (R105, R124). */
interface Unsure {
  readonly response: DialogResponse;
  readonly commandId: string;
  readonly message: string;
}
/** What the list remembers of a dialog between two cards: how often it was refused, what was typed, the answer to repeat. */
interface Slot {
  readonly attempt: number;
  readonly typed?: string | undefined;
  readonly unsure?: Unsure | undefined;
  readonly error?: string | undefined;
}
type Slots = Readonly<Record<string, Slot>>;

/** Slots of dialogs that are no longer open are dropped, so the table never outgrows the open dialogs. */
function pruned(slots: Slots, open: readonly Dialog[]): Slots {
  const stale = Object.keys(slots).filter((id) => !open.some((dialog) => dialog.id === id));
  if (stale.length === 0) return slots;
  return Object.fromEntries(Object.entries(slots).filter(([id]) => !stale.includes(id)));
}

/**
 * Every open dialog of a session, oldest first. Each card answers once. A refused answer builds the card again (a new
 * key) so the owner can answer; an answer whose outcome is unknown keeps the card shut and offers the same answer again
 * under the same command id, which the daemon answers from its receipt instead of applying it twice.
 */
export function DialogList(props: {
  readonly sessionId: string;
  readonly dialogs: readonly Dialog[];
  /** Open dialogs the snapshot could not carry (Task 16). */
  readonly hidden: number;
}) {
  const runtime = getRuntime();
  const t = useT();
  const locale = useLocale();
  const { sessionId, dialogs } = props;
  const [slots, setSlots] = useState<Slots>({});
  const inFlight = useRef(new Set<string>());

  // Adjusting state while rendering: what is remembered of a dialog that has closed is dropped at once.
  const open = pruned(slots, dialogs);
  if (open !== slots) setSlots(open);

  const patch = (id: string, change: (slot: Slot) => Slot) =>
    setSlots((current) => ({ ...current, [id]: change(current[id] ?? { attempt: 0 }) }));

  const send = (dialog: Dialog, response: DialogResponse, retryId?: string) => {
    if (inFlight.current.has(dialog.id)) return;
    inFlight.current.add(dialog.id);
    const commandId = retryId ?? runtime.rpc.newCommandId();
    patch(dialog.id, (slot) => ({ ...slot, unsure: undefined, error: undefined }));
    runtime.rpc
      .call("sessions.respondDialog", { sessionId, dialogId: dialog.id, response }, { commandId })
      .then(
        () => undefined,
        (failure: unknown) => {
          const message = failureText(failure);
          if (outcomeUnknown(failure)) {
            // Said next to the card, with the way to repeat the answer; not again as an alert.
            patch(dialog.id, (slot) => ({ ...slot, unsure: { response, commandId, message } }));
          } else {
            const typed = "value" in response ? response.value : undefined;
            patch(dialog.id, (slot) => ({
              attempt: slot.attempt + 1,
              typed,
              unsure: undefined,
              error: message,
            }));
          }
        },
      )
      .finally(() => inFlight.current.delete(dialog.id));
  };

  return (
    <>
      {dialogs.map((dialog) => {
        const slot = slots[dialog.id];
        const key = `${dialog.id}:${slot?.attempt ?? 0}`;
        const onAnswer = (response: DialogResponse) => send(dialog, response);
        return (
          <div key={dialog.id} data-dialog className="flex flex-col gap-2">
            {dialog.method === "approval" ? (
              <ApprovalCardFor key={key} dialog={dialog} onAnswer={onAnswer} />
            ) : dialog.method === "select" ? (
              <SelectDialog key={key} dialog={dialog} onAnswer={onAnswer} />
            ) : dialog.method === "confirm" ? (
              <ConfirmDialog key={key} dialog={dialog} onAnswer={onAnswer} />
            ) : (
              <TextDialog key={key} dialog={dialog} initial={slot?.typed} onAnswer={onAnswer} />
            )}
            {slot?.error ? (
              <p role="alert" className="text-ui text-attn">
                {slot.error}
              </p>
            ) : null}
            {slot?.unsure ? (
              <div role="status" className="flex items-center gap-2 border-l-2 border-attn-line px-3 py-2">
                <p className="flex-1 text-ui text-fg">{slot.unsure.message}</p>
                <Button
                  variant="primary"
                  onClick={() => slot.unsure && send(dialog, slot.unsure.response, slot.unsure.commandId)}
                >
                  {t("dialog.retry")}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {props.hidden > 0 ? (
        <p role="status" className="text-ui text-muted">
          {plural(locale, "dialog.hidden", props.hidden)}
        </p>
      ) : null}
    </>
  );
}
