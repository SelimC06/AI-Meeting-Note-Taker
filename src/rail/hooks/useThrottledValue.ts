import { useEffect, useRef, useState } from "react";

// Returns `value`, updated at most once per `intervalMs`: the first change
// after a quiet period goes through immediately, later ones within the
// window collapse into a single trailing update carrying the latest value
// (so the final value is never dropped).
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;
  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wait = intervalMs - (Date.now() - lastEmitRef.current);
    if (wait <= 0) {
      lastEmitRef.current = Date.now();
      setThrottled(value);
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
    }, wait);
  }, [value, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return throttled;
}
