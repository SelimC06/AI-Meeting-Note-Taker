import React, { useEffect, useRef, useState } from "react";
import {
  getSessionActionItems,
  getSessionTranscript,
  updateSpeakerNames,
  type ActionItem,
  type Session,
  type TranscriptSegment,
} from "../api";
import { useDialog } from "../hooks/useDialog";

interface Props {
  session: Session;
  onClose: () => void;
}

type ModalView = "notes" | "transcript";

const viewButtonClass = (isSelected: boolean) =>
  "px-1.5 py-0.5 rounded-sm text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
  (isSelected ? "bg-signal text-void" : "text-dim hover:text-phosphor");

// Deterministic label -> color, so a speaker keeps the same color across
// the whole transcript without a fixed palette running out past 2-3
// speakers. "You" is intentionally not run through this -- it always stays
// the primary phosphor color for continuity with Track A's original
// styling. Keyed on raw_speaker (not the resolved display name) so a
// speaker's color doesn't change just because they were renamed.
function speakerColor(rawLabel: string): string {
  let hash = 0;
  for (let i = 0; i < rawLabel.length; i++) {
    hash = (hash * 31 + rawLabel.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 45%, 72%)`;
}

const SpeakerLabel: React.FC<{
  displayName: string;
  rawLabel: string;
  isYou: boolean;
  onRename: (rawLabel: string, newName: string) => void;
}> = ({ displayName, rawLabel, isYou, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);

  if (isYou) {
    return <span className="text-phosphor">{displayName}</span>;
  }

  if (editing) {
    const commit = () => {
      setEditing(false);
      const trimmed = draft.trim();
      if (trimmed && trimmed !== displayName) onRename(rawLabel, trimmed);
    };
    return (
      <input
        aria-label={`New name for ${rawLabel}`}
        className="bg-void text-phosphor border border-line rounded-sm px-1 text-xs w-24 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(displayName);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      aria-label={`Rename ${rawLabel}`}
      onClick={() => {
        setDraft(displayName);
        setEditing(true);
      }}
      className="hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded-sm"
      style={{ color: speakerColor(rawLabel) }}
    >
      {displayName}
    </button>
  );
};

const TranscriptView: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [error, setError] = useState(false);
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  const [renameError, setRenameError] = useState<string | null>(null);
  // Per raw label: the latest rename's generation, so only the newest
  // rename's failure rolls back (an older one failing after a newer one
  // was typed must not undo the newer name).
  const renameGenerationRef = useRef<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setError(false);
    setNameOverrides({});
    setRenameError(null);
    renameGenerationRef.current = {};
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

  const handleRename = (rawLabel: string, newName: string) => {
    // Optimistic: apply immediately so every segment sharing this raw label
    // updates together, without waiting on the round trip.
    const hadOverride = rawLabel in nameOverrides;
    const previousName = nameOverrides[rawLabel];
    const generation = (renameGenerationRef.current[rawLabel] ?? 0) + 1;
    renameGenerationRef.current[rawLabel] = generation;
    setRenameError(null);
    setNameOverrides((prev) => ({ ...prev, [rawLabel]: newName }));
    updateSpeakerNames(sessionId, { [rawLabel]: newName }).catch((e) => {
      // The failure used to be swallowed: the new name stayed on screen as
      // if saved and silently reverted on the next open. Put the old name
      // back now and say so.
      if (renameGenerationRef.current[rawLabel] !== generation) return;
      setNameOverrides((prev) => {
        const next = { ...prev };
        if (hadOverride) next[rawLabel] = previousName;
        else delete next[rawLabel];
        return next;
      });
      setRenameError(`Couldn't rename speaker: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

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
        No speech was transcribed for this recording.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 text-xs space-y-2">
      {renameError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-red-400">
          <span>{renameError}</span>
          <button
            aria-label="dismiss rename error"
            onClick={() => setRenameError(null)}
            className="hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal shrink-0"
          >
            [x]
          </button>
        </div>
      )}
      {segments.map((seg, i) => {
        if (seg.speaker == null && seg.raw_speaker == null) {
          return (
            <div key={i} className="text-phosphor">
              {seg.text}
            </div>
          );
        }
        const rawLabel = seg.raw_speaker ?? seg.speaker ?? "Unknown";
        const displayName = nameOverrides[rawLabel] ?? seg.speaker ?? "Unknown";
        const isYou = rawLabel === "You";
        return (
          <div key={i} className={isYou ? "pl-0" : "pl-4"}>
            <SpeakerLabel
              displayName={displayName}
              rawLabel={rawLabel}
              isYou={isYou}
              onRename={handleRename}
            />
            <span className="text-dim">: </span>
            <span className="text-phosphor">{seg.text}</span>
          </div>
        );
      })}
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
  const { dialogProps, titleId } = useDialog({ onEscape: onClose });

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
      <div
        {...dialogProps}
        className="w-full max-w-md h-full max-h-[80%] bg-panel border border-line rounded-sm flex flex-col focus:outline-none"
      >
        <div className="px-3 py-2 border-b border-line flex items-center justify-between text-xs text-phosphor">
          <h2 id={titleId} className="truncate font-normal">
            {session.title}
          </h2>
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
