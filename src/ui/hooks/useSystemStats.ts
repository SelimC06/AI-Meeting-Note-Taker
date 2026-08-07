import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 1500;

export function useSystemStats(active: boolean) {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = () => {
      window.systemAPI?.getStats().then((s) => {
        if (!cancelled) setStats(s ?? null);
      });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  return stats;
}
