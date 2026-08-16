import React, { useEffect, useState } from "react";
import { getSessionTranscript, type Session, type TranscriptSegment } from "../api";

interface Props {
  session: Session;
  onClose: () => void;
}

type ModalView = "notes" | "transcript";

const viewButtonClass = (isSelected: boolean) =>
  "px-1.5 py-0.5 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
  (isSelected ? "bg-signal text-void" : "text-dim hover:text-phosphor");

const TranscriptView: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setError(false);
    getSessionTranscript(sessionId)
      .then((result) => {
        if (!cancelled) setSegments(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto px-3 py-2 text-xs text-dim">
        Couldn't load transcript. Try again later.
      </div>
    );
  }

  if (segments === null) {
    return <div className="flex-1 overflow-y-auto px-3 py-2 text-xs text-dim">Loading transcript...</div>;
  }

  if (segments.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-3 py-2 text-xs text-dim">
        No structured transcript available for this recording. This is captured only when both
        your microphone and system audio were recorded separately.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 text-xs space-y-2">
      {segments.map((seg, i) => (
        <div key={i} className={seg.speaker === "You" ? "pl-0" : "pl-4"}>
          <span className={seg.speaker === "You" ? "text-phosphor" : "text-dim"}>
            {seg.speaker ?? "Unknown"}
          </span>
          <span className="text-dim">: </span>
          <span className="text-phosphor">{seg.text}</span>
        </div>
      ))}
    </div>
  );
};

const NotesModal: React.FC<Props> = ({ session, onClose }) => {
  const [view, setView] = useState<ModalView>("notes");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 bg-void/80 flex items-center justify-center px-6 py-6 [-webkit-app-region:no-drag]">
      <div className="w-full max-w-md h-full max-h-[80%] bg-panel border border-line rounded-sm flex flex-col">
        <div className="px-3 py-2 border-b border-line flex items-center justify-between text-xs text-phosphor">
          <span className="truncate">{session.title}</span>
          <button
            onClick={onClose}
            aria-label="Close notes"
            className="text-dim hover:text-phosphor px-1.5 py-0.5 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            [close]
          </button>
        </div>
        <div className="px-3 py-1.5 border-b border-line flex items-center gap-1">
          <button className={viewButtonClass(view === "notes")} onClick={() => setView("notes")}>
            Notes
          </button>
          <button
            className={viewButtonClass(view === "transcript")}
            onClick={() => setView("transcript")}
          >
            Transcript
          </button>
        </div>
        {view === "notes" ? (
          <pre className="flex-1 overflow-y-auto px-3 py-2 text-xs whitespace-pre-wrap text-phosphor">
            {session.notes}
          </pre>
        ) : (
          <TranscriptView sessionId={session.id} />
        )}
      </div>
    </div>
  );
};

export default NotesModal;
