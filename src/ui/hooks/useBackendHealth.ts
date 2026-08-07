import { useEffect, useState } from "react";
import { getHealthStatus, type HealthStatus } from "../api";

const POLL_INTERVAL_MS = 15000;

export function useBackendHealth(active: boolean) {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = () => {
      getHealthStatus().then((h) => {
        if (!cancelled) setHealth(h);
      });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  return health;
}
