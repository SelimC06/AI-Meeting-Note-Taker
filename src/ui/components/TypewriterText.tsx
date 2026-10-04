import { useEffect, useState } from "react";

// How fast a fresh caption types on: the whole text is always on screen
// within ~MAX_TICKS * TICK_MS (about half a second), however long it is --
// captions must never still be animating when the next window's text
// arrives.
const TICK_MS = 16;
const MAX_TICKS = 30;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
}

// Types its text on character by character (used for the newest live
// caption, so new speech visibly "arrives" instead of popping in). With
// reduced motion the text renders at once.
export default function TypewriterText({ text }: { text: string }) {
  const [count, setCount] = useState(() => (prefersReducedMotion() ? text.length : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const step = Math.max(1, Math.ceil(text.length / MAX_TICKS));
    const id = window.setInterval(() => {
      setCount((current) => {
        const next = current + step;
        if (next >= text.length) {
          window.clearInterval(id);
          return text.length;
        }
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [text]);

  return <>{text.slice(0, count)}</>;
}
