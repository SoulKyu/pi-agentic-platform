import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import fixtureAfter from "../fixtures/after.ts?raw";
import fixtureBefore from "../fixtures/before.ts?raw";
import { bigFixture } from "./big-fixture.ts";
import { type CodeMirrorReview, mountCodeMirrorReview } from "./codemirror-review.ts";
import { addComment, type LineComment } from "./comments.ts";
import { PierreReview } from "./pierre-review.tsx";
import "./tokens.css";

declare const __CANDIDATE__: "codemirror" | "pierre" | "none";

const lines = Number(new URLSearchParams(location.search).get("lines"));
const { before, after } = lines > 0 ? bigFixture(fixtureBefore, fixtureAfter, lines) : { before: fixtureBefore, after: fixtureAfter };

function App() {
  const [comments, setComments] = useState<LineComment[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const review = useRef<CodeMirrorReview | null>(null);
  const onComment = (line: number, side: LineComment["side"]) => {
    const text = window.prompt(`Comment on ${side} line ${line}`) ?? "";
    if (text) setComments((list) => addComment(list, { line, side, text }));
  };
  useEffect(() => {
    if (__CANDIDATE__ !== "codemirror" || !host.current) return undefined;
    review.current = mountCodeMirrorReview(host.current, before, after, onComment);
    return () => review.current?.destroy();
  }, []);
  useEffect(() => review.current?.setComments(comments), [comments]);
  return (
    <main>
      <h1>{__CANDIDATE__}</h1>
      {__CANDIDATE__ === "pierre" ? <PierreReview before={before} after={after} fileName="worktree.ts" comments={comments} onComment={onComment} /> : <div ref={host} />}
      <ol data-testid="comments">{comments.map((c) => <li key={`${c.side}:${c.line}`}>{c.side} {c.line}: {c.text}</li>)}</ol>
    </main>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
