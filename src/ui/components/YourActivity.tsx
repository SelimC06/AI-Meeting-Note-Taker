import React, { useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

const YourActivity: React.FC = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
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
  }, []);

  const count = sessions?.length ?? 0;
  const mostRecentTitle = sessions?.[0]?.title;

  return (
    <div className="p-4 w-50 bg-panel border border-line rounded-sm text-phosphor">
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
