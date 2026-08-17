import React, { useEffect, useState } from "react";
import {
  getSessionActionItems,
  getSessionTranscript,
  type ActionItem,
  type Session,
  type TranscriptSegment,
} from "../api";

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

// null = structured action items unavailable for this session (old
// session, or the backend's own malformed-JSON retry chain still failed
// both attempts) -- render the plain prose notes exactly as before this
// feature existed, never a broken or empty checklist.
const ActionItemsChecklist: React.FC<{ items: ActionItem[]; checked: Set<number>; onToggle: (i: number) => void }> = ({
  items,
  checked,
  onToggle,
}) => (
  <div className="px-3 py-2 border-b border-line">
    <div className="text-xs text-dim mb-1">Action Items</div>
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={checked.has(i)}
            onChange={() => onToggle(i)}
            aria-label={item.text}
            className="mt-0.5"
          />
          <span className={checked.has(i) ? "line-through text-dim" : "text-phosphor"}>
            {item.text}
            {item.owner ? <span className="text-dim"> — {item.owner}</span> : null}
            {item.due ? <span className="text-dim"> (due {item.due})</span> : null}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

const NotesModal: React.FC<Props> = ({ session, onClose }) => {
  const [view, setView] = useState<ModalView>("notes");
  const [actionItems, setActionItems] = useState<ActionItem[] | null>(null);
  const [checkedIndexes, setCheckedIndexes] = useState<Set<number>>(new Set());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setActionItems(null);
    setCheckedIndexes(new Set());
    getSessionActionItems(session.id)
      .then((result) => {
        if (!cancelled) setActionItems(result);
      })
      .catch(() => {
        // Network/parse failure fetching the endpoint itself -- same
        // fallback as the backend returning null: show prose notes.
        if (!cancelled) setActionItems(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const toggleChecked = (index: number) => {
    setCheckedIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

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
          <div className="flex-1 overflow-y-auto flex flex-col">
            {actionItems && actionItems.length > 0 ? (
              <ActionItemsChecklist items={actionItems} checked={checkedIndexes} onToggle={toggleChecked} />
            ) : null}
            <pre className="px-3 py-2 text-xs whitespace-pre-wrap text-phosphor">{session.notes}</pre>
          </div>
        ) : (
          <TranscriptView sessionId={session.id} />
        )}
      </div>
    </div>
  );
};

export default NotesModal;
