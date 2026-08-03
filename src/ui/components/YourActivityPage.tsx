import React, { useEffect, useState } from "react";
import { getSessions, type Session } from "../api";

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

const YourActivityPage: React.FC = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-sm font-semibold tracking-wide uppercase">[ACTIVITY]</h1>
          <p className="text-xs text-dim">
            recent meetings and notes captured by the app
          </p>
        </div>
      </div>

      <div className="mt flex-1 bg-panel border border-line rounded-sm overflow-y-auto">
        {error && (
          <div className="h-full flex items-center justify-center text-xs text-red-400">
            failed to load activity: {error}
          </div>
        )}

        {!error && sessions === null && (
          <div className="h-full flex items-center justify-center text-xs text-dim">
            loading<span className="cursor-blink">▌</span>
          </div>
        )}

        {!error && sessions !== null && sessions.length === 0 && (
          <div className="h-full flex items-center justify-center text-xs text-dim">
            no meetings recorded yet<span className="cursor-blink">▌</span>
          </div>
        )}

        {!error && sessions !== null && sessions.length > 0 && !selected && (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelectedId(s.id)}
                  className="w-full text-left px-4 py-2 text-xs hover:bg-signal hover:text-void transition focus:outline-none focus:ring-2 focus:ring-signal"
                >
                  [{formatRelativeTime(s.created_at)}] {s.title}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!error && selected && (
          <div className="h-full flex flex-col">
            <div className="px-4 py-2 border-b border-line flex items-center justify-between text-xs">
              <span>{selected.title}</span>
              <button
                onClick={() => setSelectedId(null)}
                className="text-dim hover:bg-signal hover:text-void px-1.5 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal"
              >
                [back]
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto px-4 py-3 text-xs whitespace-pre-wrap">
              {selected.notes}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default YourActivityPage;
