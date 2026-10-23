import type { WireClass } from "@pap/contracts";
import { clipName } from "./meta.ts";

type Locale = "en" | "fr";

const GENERIC: Record<Exclude<WireClass, "digest">, Record<Locale, string>> = {
  approval: { en: "A request is waiting for your answer.", fr: "Une demande attend votre réponse." },
  failed: { en: "A task did not finish.", fr: "Une tâche ne s'est pas terminée." },
  budget: { en: "A budget is reached.", fr: "Un budget est atteint." },
  notify: { en: "An agent has a message for you.", fr: "Un agent a un message pour vous." },
  done: { en: "A task is done.", fr: "Une tâche est terminée." },
  reply: { en: "An agent has replied.", fr: "Un agent a répondu." },
  test: { en: "Test notification.", fr: "Notification de test." },
};

const waiting = (n: number, locale: Locale) =>
  locale === "fr"
    ? n === 1
      ? "1 élément vous attend."
      : `${n} éléments vous attendent.`
    : n === 1
      ? "1 item is waiting for you."
      : `${n} items are waiting for you.`;
const expiredLine = (m: number, locale: Locale) =>
  locale === "fr"
    ? m === 1
      ? "1 demande a expiré pendant les heures calmes."
      : `${m} demandes ont expiré pendant les heures calmes.`
    : m === 1
      ? "1 request expired during quiet hours."
      : `${m} requests expired during quiet hours.`;

/**
 * The text of a push (M12R7): the title is always "pap" and the body one fixed sentence per class. A `name` (the caller
 * passes it only when the owner chose `titles: "names"`, and only a registry name) is appended after a dash; never for
 * a digest or a test.
 */
export function copyFor(
  cls: WireClass,
  locale: Locale,
  extra: { name?: string; n?: number; expired?: number } = {},
): { title: string; body: string } {
  if (cls === "digest") {
    const parts: string[] = [];
    const n = extra.n ?? 0;
    const expired = extra.expired ?? 0;
    if (n > 0 || expired === 0) parts.push(waiting(n, locale));
    if (expired > 0) parts.push(expiredLine(expired, locale));
    return { title: "pap", body: parts.join(" ") };
  }
  const base = GENERIC[cls][locale];
  const name = cls === "test" || extra.name === undefined ? "" : clipName(extra.name);
  return { title: "pap", body: name === "" ? base : `${base} - ${name}` };
}
