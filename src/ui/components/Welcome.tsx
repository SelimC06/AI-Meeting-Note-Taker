import React from "react";
import type { Session } from "../api";
import { formatRelativeTime } from "../utils/formatRelativeTime";

interface Props {
  sessions: Session[];
}

const GLYPH = ["  ▄▄▄  ", " █▓▓▓█ ", " █▓▓▓█ ", "  ▀▀▀  ", "  ███  ", " █████ "].join("\n");

const TIPS = [
  "click Start to open the rail, then hit record",
  "select a meeting to ask questions about it",
  "Ctrl/Cmd+B toggles the sidebar",
];

function mostRecent(sessions: Session[]): Session | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((latest, s) =>
    new Date(s.created_at).getTime() > new Date(latest.created_at).getTime() ? s : latest
  );
}

const Welcome: React.FC<Props> = ({ sessions }) => {
  const latest = mostRecent(sessions);
  const count = sessions.length;
  const relativeTime = latest ? formatRelativeTime(latest.created_at) : "";

  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <div className="w-full max-w-lg border border-line rounded-sm bg-panel flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-line text-xs">
        <div className="flex-1 p-4 flex flex-col gap-3">
          <pre
            aria-hidden="true"
            className="font-sans text-signal leading-none text-[10px] select-none"
          >
            {GLYPH}
          </pre>
          <div>
            <p className="text-signal font-semibold">DeskRecap</p>
            <p className="text-dim">record → transcribe → summarize → chat</p>
          </div>
          <div>
            <p className="text-phosphor mb-1">Tips</p>
            <ul className="text-dim flex flex-col gap-0.5">
              {TIPS.map((tip) => (
                <li key={tip} className="pl-3 -indent-3">
                  · {tip}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-1">
          <p className="text-phosphor mb-1">Recent activity</p>
          {latest ? (
            <>
              <p className="text-dim">
                {count} meeting{count === 1 ? "" : "s"} recorded
              </p>
              <p className="text-dim flex gap-1 min-w-0">
                <span className="truncate" title={latest.title}>
                  last: "{latest.title}"
                </span>
                {relativeTime && <span className="shrink-0">— {relativeTime}</span>}
              </p>
            </>
          ) : (
            <p className="text-dim">no meetings recorded yet</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default Welcome;
