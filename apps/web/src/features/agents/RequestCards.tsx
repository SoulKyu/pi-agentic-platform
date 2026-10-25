import "./register-space-catalog.ts";
import type { AgentRequestView } from "@pap/contracts";
import { Button, Chip, InlineError, usePendingAction } from "@pap/ui";
import { type ReactNode, useId, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { UntrustedText } from "./UntrustedText.tsx";
import { lineOf } from "./untrusted-text.ts";

export interface RequestCardsProps {
  readonly agentName: string;
  /** This agent's requests, oldest first. */
  readonly requests: readonly AgentRequestView[];
  /** The thread's current taint: the dashed external content chip (W5-R38). */
  readonly tainted: boolean;
  readonly now: number;
  /** Opens the secret dialog (Task 27) for that request; without it, Provide… waits. */
  onProvide?(request: AgentRequestView): void;
}

/** What a card does with a call: one at a time, its failure in words under the buttons. */
function useCall() {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (call: (rpc: ReturnType<typeof getRuntime>["rpc"]) => Promise<unknown>) =>
    void pending.run(async () => {
      setProblem(null);
      try {
        await call(getRuntime().rpc);
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return { since: pending.since, problem, run };
}

const expired = (request: AgentRequestView, now: number): boolean => request.expiresAt <= now;

function Remaining({ request, now }: { readonly request: AgentRequestView; readonly now: number }) {
  const t = useT();
  if (expired(request, now))
    return <span className="font-mono text-label text-attn">{t("agentSpace.request.expired")}</span>;
  const minutes = Math.floor((request.expiresAt - now) / 60_000);
  return (
    <span className="font-mono text-label text-muted">
      {minutes < 1 ? t("agentSpace.request.soon") : t("agentSpace.request.minutes", { n: minutes })}
    </span>
  );
}

function Frame({
  title,
  tainted,
  request,
  now,
  children,
}: {
  readonly title: string;
  readonly tainted: boolean;
  readonly request: AgentRequestView;
  readonly now: number;
  readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <section
      data-request={request.kind}
      className="flex flex-col gap-s1 rounded-md border border-attn-line bg-attn-tint p-s2"
    >
      <h3 className="flex flex-wrap items-center gap-s2 text-ui font-semibold text-attn-title">
        <span className="min-w-0 break-words">{title}</span>
        {tainted ? <Chip tone="ext" label={t("agentSpace.header.external")} /> : null}
        <span className="ml-auto">
          <Remaining request={request} now={now} />
        </span>
      </h3>
      {children}
    </section>
  );
}

function Untrusted({ children }: { readonly children: string }) {
  const t = useT();
  return (
    <figure data-untrusted="" className="flex flex-col gap-s1">
      <figcaption className="label-hud text-attn">
        {t("agentSpace.request.source", { source: t("agentSpace.request.sourceAgent") })}
      </figcaption>
      <UntrustedText text={children} />
    </figure>
  );
}

function ApprovalRequest({ agentName, request, tainted, now }: CardProps) {
  const t = useT();
  const call = useCall();
  const gone = expired(request, now);
  const answer = (approved: boolean) =>
    call.run((rpc) =>
      rpc.call(
        "agents.answerApproval",
        { requestId: request.id, approved },
        { commandId: rpc.newCommandId() },
      ),
    );
  return (
    <Frame
      title={t("agentSpace.request.approve", { name: agentName, title: lineOf(request.title) })}
      tainted={tainted}
      request={request}
      now={now}
    >
      {request.detail === null ? null : <Untrusted>{request.detail}</Untrusted>}
      <p className="text-label text-muted">{t("agentSpace.request.approveNote", { name: agentName })}</p>
      <div className="flex flex-wrap gap-s2">
        <Button size="sm" disabled={gone} pendingSince={call.since} onClick={() => answer(false)}>
          {t("agentSpace.request.deny")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={gone}
          pendingSince={call.since}
          onClick={() => answer(true)}
        >
          {t("agentSpace.request.approveButton")}
        </Button>
      </div>
      {call.problem !== null ? <InlineError announce="action">{call.problem}</InlineError> : null}
    </Frame>
  );
}

function SecretRequest({ agentName, request, tainted, now, onProvide }: CardProps) {
  const t = useT();
  const call = useCall();
  const gone = expired(request, now);
  const hintId = useId();
  const decline = () =>
    call.run((rpc) =>
      rpc.call("secrets.declineRequest", { requestId: request.id }, { commandId: rpc.newCommandId() }),
    );
  return (
    <Frame
      title={t("agentSpace.request.secret", { name: agentName, secret: lineOf(request.title) })}
      tainted={tainted}
      request={request}
      now={now}
    >
      {request.detail === null ? null : <Untrusted>{request.detail}</Untrusted>}
      <div className="flex flex-wrap gap-s2">
        <Button size="sm" disabled={gone} pendingSince={call.since} onClick={decline}>
          {t("agentSpace.request.decline")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={gone || onProvide === undefined}
          aria-describedby={onProvide === undefined ? hintId : undefined}
          onClick={() => onProvide?.(request)}
        >
          {t("agentSpace.request.provide")}
        </Button>
        {onProvide === undefined ? (
          <span id={hintId} className="self-center text-label text-muted">
            {t("agentSpace.request.provideHint")}
          </span>
        ) : null}
      </div>
      {call.problem !== null ? <InlineError announce="action">{call.problem}</InlineError> : null}
    </Frame>
  );
}

interface CardProps extends Omit<RequestCardsProps, "requests"> {
  readonly request: AgentRequestView;
}

/**
 * The requests this agent waits on, pinned above the composer (M11R120, decision 80). The agent's title and detail are
 * its own words: shown as text, never as markup, and the summary under the untrusted label.
 */
export function RequestCards({ requests, ...rest }: RequestCardsProps) {
  const t = useT();
  if (requests.length === 0) return null;
  return (
    <div role="region" aria-label={t("agentSpace.request.region")} className="flex flex-col gap-s2">
      {requests.map((request) =>
        request.kind === "approve" ? (
          <ApprovalRequest key={request.id} request={request} {...rest} />
        ) : (
          <SecretRequest key={request.id} request={request} {...rest} />
        ),
      )}
    </div>
  );
}
