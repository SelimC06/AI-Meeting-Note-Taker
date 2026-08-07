import React, { useEffect, useState } from "react";
import { checkHealth } from "../api";

const POLL_INTERVAL_MS = 15000;

interface Props {
  active: boolean;
}

const Status: React.FC<Props> = ({ active }) => {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = () => {
      checkHealth().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  return (
    <div className="p-4 flex-1 min-w-0 bg-panel border border-line rounded-sm text-phosphor">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[STATUS]</h2>
      <div className="flex items-center gap-2 text-sm">
        <span className={online ? "text-signal" : "text-dim"}>
          {online ? "●" : "○"}
        </span>
        <span>
          backend: {online === null ? "checking..." : online ? "online" : "offline"}
        </span>
      </div>
    </div>
  );
};

export default Status;
