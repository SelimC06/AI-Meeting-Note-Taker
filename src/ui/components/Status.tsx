import React, { useEffect, useState } from "react";
import { checkHealth } from "../api";

const POLL_INTERVAL_MS = 15000;

const Status: React.FC = () => {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
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
  }, []);

  return (
    <div className="p-4 w-100 bg-panel border border-line rounded-sm text-phosphor">
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
