import "../../../i18n/register-reply-tools.ts";
import {
  PromptTemplateName,
  RESERVED_TEMPLATE_NAMES,
  TEMPLATE_LIMITS,
  TemplateBody,
  TemplateDescription,
} from "@pap/contracts";
import { Button, InlineError, TextField, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { errorKey, useT } from "../../../i18n/index.ts";
import { useStepUpRunner } from "../../../lib/step-up-context.tsx";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { getRuntime, RpcError } from "../../../runtime/index.ts";

const RESERVED: readonly string[] = RESERVED_TEMPLATE_NAMES;
const tooLong = (body: string): boolean => new TextEncoder().encode(body).length > TEMPLATE_LIMITS.bodyBytes;
const oneLine = (text: string): string =>
  Array.from(stripHidden(text).replace(/\s+/g, " ")).slice(0, TEMPLATE_LIMITS.description).join("");

type Phase = "edit" | "conflict" | "saved";

/**
 * Saves one of your messages as a Pi prompt template (UX-1): `<Pi agent dir>/prompts/<name>.md`, written by the daemon
 * after the owner's password. A name that exists is told, and replaced only by a second, explicit click.
 */
export function SaveTemplateDialog({ text, onClose }: { readonly text: string; onClose(): void }) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(() => stripHidden(text));
  const [phase, setPhase] = useState<Phase>("edit");
  const [problem, setProblem] = useState<string | null>(null);

  const nameOk = PromptTemplateName.safeParse(name).success;
  const nameError =
    name === "" || nameOk
      ? null
      : RESERVED.includes(name)
        ? t("reply.template.nameReserved", { name })
        : t("reply.template.nameInvalid");
  const bodyError = tooLong(body) ? t("reply.template.tooLong") : null;
  const valid =
    nameOk &&
    bodyError === null &&
    TemplateBody.safeParse(body).success &&
    TemplateDescription.safeParse(description).success;

  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPhase("edit");
      setProblem(null);
    };

  const save = (replace: boolean) =>
    void pending.run(async () => {
      setProblem(null);
      const params = {
        name,
        ...(description === "" ? {} : { description }),
        body,
        ...(replace ? { replace: true } : {}),
      };
      try {
        const done = await stepUp((commandId) =>
          getRuntime().rpc.call("templates.save", params, { commandId }),
        );
        if (done !== null) setPhase("saved");
      } catch (failure) {
        const code = failure instanceof RpcError ? failure.code : "internal";
        if (code === "conflict" && !replace) setPhase("conflict");
        else setProblem(t(errorKey(code)));
      }
    });

  const saved = phase === "saved";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("reply.template.title")}
      closeLabel={t("ui.close")}
      footer={
        saved ? (
          <Button variant="primary" onClick={onClose}>
            {t("ui.close")}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t("reply.template.cancel")}</Button>
            {phase === "conflict" ? (
              <Button
                variant="primary"
                disabled={!valid}
                pendingSince={pending.since}
                onClick={() => save(true)}
              >
                {t("reply.template.replace")}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!valid}
                pendingSince={pending.since}
                onClick={() => save(false)}
              >
                {t("reply.template.save")}
              </Button>
            )}
          </>
        )
      }
    >
      <div data-save-template="" className="flex flex-col gap-s3 p-s3">
        {saved ? (
          <div role="status" className="flex flex-col gap-s1 text-ui">
            <p className="text-fg">{t("reply.template.saved", { name })}</p>
            <p className="text-muted">{t("reply.template.when")}</p>
            <p className="text-muted">{t("reply.template.box")}</p>
          </div>
        ) : (
          <>
            <TextField
              label={t("reply.template.name")}
              value={name}
              onChange={edited(setName)}
              hint={t("reply.template.nameHint")}
              error={nameError}
              autoComplete="off"
            />
            <TextField
              label={t("reply.template.description")}
              value={description}
              onChange={edited((value: string) => setDescription(oneLine(value)))}
              autoComplete="off"
            />
            <TextField
              label={t("reply.template.body")}
              value={body}
              onChange={edited((value: string) => setBody(stripHidden(value)))}
              hint={t("reply.template.help")}
              error={bodyError}
              multiline
              mono
            />
            {phase === "conflict" ? (
              <InlineError announce="action">{t("reply.template.exists", { name })}</InlineError>
            ) : null}
            {problem !== null ? <InlineError announce="action">{problem}</InlineError> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
