import { PushTarget } from "@pap/contracts";
import { Button, EmptyState } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import "../../i18n/register-landing.ts";
import { errorKey, useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError, type RpcErrorCode, windowTimers } from "../../runtime/index.ts";
import type { Timers } from "../../runtime/connection.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { isPushId } from "./landing-path.ts";
import { type Destination, destinationOf, verdictOf } from "./landing.vm.ts";

/** How long the landing waits for the stream that says whether the question still waits, before it goes there anyway. */
const STREAM_WAIT_MS = 5_000;

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "notFound" }
  | { readonly kind: "failed"; readonly code: RpcErrorCode }
  | { readonly kind: "resolved"; readonly destination: Destination };

const LOADING: Phase = { kind: "loading" };
const NOT_FOUND: Phase = { kind: "notFound" };

type Navigate = ReturnType<typeof useNavigate>;

/** What the shell gives the landing: the page of a destination (null for an id it refuses), and the page the Inbox opens over. */
export interface LandingRoutes {
  pathOf(destination: Destination): string | null;
  inboxPath(): string;
}

/** Shows a destination. The landing's own history entry is replaced, so Back never returns to it. */
function goTo(navigate: Navigate, routes: LandingRoutes, destination: Destination): void {
  const to = destination.kind === "inbox" ? routes.inboxPath() : routes.pathOf(destination);
  if (to === null) return;
  if (destination.kind === "inbox") useInboxReveal.getState().ask(destination.itemId);
  navigate({ to, replace: true }).catch(() => reportClientIssue("command_failed"));
}

async function resolve(id: string, routes: LandingRoutes): Promise<Phase> {
  try {
    const answer = await getRuntime().rpc.call("push.open", { id });
    const target = PushTarget.safeParse((answer as { target?: unknown }).target);
    const destination = target.success ? destinationOf(target.data) : null;
    return destination === null || routes.pathOf(destination) === null
      ? NOT_FOUND
      : { kind: "resolved", destination };
  } catch (failure) {
    const code = failure instanceof RpcError ? failure.code : "internal";
    return code === "not_found" ? NOT_FOUND : { kind: "failed", code };
  }
}

/**
 * `/n/<id>`: what a tapped notification opens. It resolves the id on the daemon (`push.open`), then replaces its own
 * history entry with the target. Nothing the notification said is shown here, and the id is never used as a path.
 */
export default function Landing({
  id,
  routes,
  timers: given,
}: {
  readonly id: string;
  readonly routes: LandingRoutes;
  readonly timers?: Timers;
}) {
  const t = useT();
  const timers = given ?? windowTimers;
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>(() => (isPushId(id) ? LOADING : NOT_FOUND));
  const [attempt, setAttempt] = useState(0);
  const [late, setLate] = useState(false);
  const inbox = useInboxStore((state) => state.view);
  const shell = useShellStore((state) => state.view);
  const left = useRef(false);

  useEffect(() => {
    if (!isPushId(id)) return;
    let current = true;
    void resolve(id, routes).then((next) => {
      if (current) setPhase(next);
    });
    return () => {
      current = false;
    };
  }, [id, attempt, routes]);

  const verdict = phase.kind === "resolved" ? verdictOf(phase.destination, { inbox, shell }) : null;
  useEffect(() => {
    if (verdict !== "wait") return;
    const handle = timers.set(() => setLate(true), STREAM_WAIT_MS);
    return () => timers.clear(handle);
  }, [verdict, timers]);

  const final = verdict === "wait" && late ? "open" : verdict;
  useEffect(() => {
    if (final !== "open" || phase.kind !== "resolved" || left.current) return;
    left.current = true;
    goTo(navigate, routes, phase.destination);
  }, [final, phase, navigate, routes]);

  if (phase.kind === "notFound")
    return (
      <Notice>
        <EmptyState
          title={t("landing.notFound.title")}
          purpose={t("landing.notFound.purpose")}
          action={
            <Button onClick={() => void navigate({ to: "/", replace: true })}>
              {t("landing.notFound.home")}
            </Button>
          }
        />
      </Notice>
    );
  if (phase.kind === "failed")
    return (
      <Notice>
        <EmptyState
          title={t("landing.failed.title")}
          purpose={t(errorKey(phase.code))}
          action={
            <Button
              onClick={() => {
                setPhase(LOADING);
                setAttempt((count) => count + 1);
              }}
            >
              {t("landing.failed.retry")}
            </Button>
          }
        />
      </Notice>
    );
  if (final === "handled" && phase.kind === "resolved")
    return (
      <Notice>
        <EmptyState
          title={t("landing.handled.title")}
          purpose={t("landing.handled.purpose")}
          action={
            <Button onClick={() => goTo(navigate, routes, { kind: "inbox", itemId: null })}>
              {t("landing.handled.inbox")}
            </Button>
          }
        />
      </Notice>
    );
  return (
    <section data-landing-skeleton role="status" className="w-full p-s4">
      <span className="sr-only">{t("landing.loading")}</span>
      <div aria-hidden className="h-control w-full rounded-md bg-surface-2" />
    </section>
  );
}

/**
 * What replaces the skeleton. The skeleton was a status region that is gone now, so the new text would not be announced:
 * focus moves to the notice's heading instead (a screen reader reads it, and the next Tab reaches the action).
 */
function Notice({ children }: { readonly children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const heading = box.current?.querySelector("h2");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.classList.add("outline-none");
    heading.focus();
  }, []);
  return (
    <div ref={box} className="w-full p-s4">
      {children}
    </div>
  );
}
