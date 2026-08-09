import { useEffect, useRef, useState } from "react";

function format(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function useElapsedTime(status: "idle" | "starting" | "recording" | "paused"): string {
  const [elapsedMs, setElapsedMs] = useState(0);
  const accumulatedRef = useRef(0);
  const resumedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (status === "idle" || status === "starting") {
      accumulatedRef.current = 0;
      resumedAtRef.current = null;
      setElapsedMs(0);
      return;
    }

    if (status === "paused") {
      if (resumedAtRef.current !== null) {
        accumulatedRef.current += Date.now() - resumedAtRef.current;
        resumedAtRef.current = null;
      }
      return;
    }

    // status === "recording"
    resumedAtRef.current = Date.now();
    const intervalId = setInterval(() => {
      const runningSince = resumedAtRef.current ?? Date.now();
      setElapsedMs(accumulatedRef.current + (Date.now() - runningSince));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [status]);

  return format(elapsedMs);
}
