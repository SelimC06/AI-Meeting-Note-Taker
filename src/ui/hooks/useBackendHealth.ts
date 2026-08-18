import { useEffect, useState } from "react";
import { getHealthStatus, type HealthStatus } from "../api";

const POLL_INTERVAL_MS = 15000;
// While the backend hasn't been confirmed healthy even once yet (cold
// start), poll much more aggressively than the steady-state interval.
// App.tsx's error-suppression gate and its reload-on-recovery trigger for
// the sessions list both depend solely on this poll -- at a fixed 15s
// cadence, a backend that finishes a normal ~2-8s cold start could still
// leave the sidebar/chat panels sitting stuck (or briefly showing a stale
// "Failed to fetch") for up to 15 unnecessary seconds after it's actually
// already up, which reads as an intermittent bug even though nothing is
// broken. Falls back to the slow cadence once healthy is confirmed once,
// since steady-state monitoring doesn't need to be this aggressive.
const STARTUP_POLL_INTERVAL_MS = 1000;
// Fixed tick rate driving the adaptive schedule above -- deliberately NOT
// tied to promise-resolution timing (no chained setTimeout-from-.then()),
// so the cadence never depends on exactly when a fetch settles.
const TICK_MS = 1000;

export function useBackendHealth(active: boolean) {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let everHealthy = false;
    let lastPollAt = Date.now();

    const poll = () => {
      lastPollAt = Date.now();
      getHealthStatus().then((h) => {
        if (cancelled) return;
        setHealth(h);
        if (h.backend) everHealthy = true;
      });
    };

    poll();
    const tick = setInterval(() => {
      const dueIntervalMs = everHealthy ? POLL_INTERVAL_MS : STARTUP_POLL_INTERVAL_MS;
      if (Date.now() - lastPollAt >= dueIntervalMs) poll();
    }, TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [active]);

  return health;
}
