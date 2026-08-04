import React, { useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

interface Props {
  active: boolean;
}

const YourActivity: React.FC<Props> = ({ active }) => {
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getSessions()
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const count = sessions?.length ?? 0;
  const mostRecentTitle = sessions?.[0]?.title;

  return (
    <div className="p-4 w-50 h-full bg-panel border border-line rounded-sm text-phosphor transition-all duration-150 hover:-translate-y-0.5 hover:border-signal hover:shadow-[0_0_16px_-4px_var(--color-signal)]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[ACTIVITY]</h2>
      <div className="text-xs space-y-1">
        {sessions === null && (
          <p className="text-dim">
            loading<span className="cursor-blink">▌</span>
          </p>
        )}
        {sessions !== null && (
          <>
            <p>
              {count} meeting{count === 1 ? "" : "s"} recorded
            </p>
            {mostRecentTitle && <p className="text-dim">latest: {mostRecentTitle}</p>}
          </>
        )}
      </div>
    </div>
  );
};

export default YourActivity;
