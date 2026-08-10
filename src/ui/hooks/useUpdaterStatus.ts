import { useEffect, useState } from "react";

export function useUpdaterStatus(): UpdaterStatus {
  const [status, setStatus] = useState<UpdaterStatus>({ state: "not-checked" });

  useEffect(() => {
    let cancelled = false;
    window.updaterAPI?.getStatus?.().then((initial) => {
      if (!cancelled && initial) {
        setStatus(initial);
      }
    });

    const unsubscribe = window.updaterAPI?.onStatus((next: UpdaterStatus) => {
      setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return status;
}
