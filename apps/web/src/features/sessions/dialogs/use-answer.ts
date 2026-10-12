import { once } from "@pap/ui";
import { useEffect, useRef, useState } from "react";

/**
 * A card answers once. The guard is built in the click handler, never during render, and shared by every button of the card;
 * the answer goes to the latest callback, since a card can stay open for minutes (R121, R127).
 */
export function useAnswer<A>(onAnswer: (answer: A) => void) {
  const [answered, setAnswered] = useState(false);
  const latest = useRef(onAnswer);
  useEffect(() => {
    latest.current = onAnswer;
  });
  const guard = useRef<((answer: A) => boolean) | null>(null);
  const answer = (value: A) => {
    guard.current ??= once((first: A) => {
      setAnswered(true);
      latest.current(first);
    });
    guard.current(value);
  };
  return { answered, answer };
}
