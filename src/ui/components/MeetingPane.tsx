// The main-pane meeting view (UI refresh): a selected meeting opens as a
// header + notes/transcript/chat tabs in the main pane, replacing the old
// NotesModal overlay. The chat tab itself stays the existing <Chat>
// component (App toggles its visibility), so the per-meeting and
// all-meetings conversations keep their state exactly as before.
import React, { useEffect, useRef, useState } from "react";
import {
  getSessionActionItems,
  getSessionTranscript,
  updateSpeakerNames,
  type ActionItem,
  type Session,
  type TranscriptSegment,
} from "../api";
import { formatRelativeTime } from "../utils/formatRelativeTime";

export type MeetingTab = "notes" | "transcript" | "chat";

// Deterministic label -> color, so a speaker keeps the same color across
// the whole app without a fixed palette running out past 2-3 speakers.
// "You" is intentionally not run through this -- it stays phosphor. Keyed
// on raw_speaker so a rename never changes someone's color. Lightness
// flips with the theme: the dark values are unreadable on paper.
function speakerColor(rawLabel: string): string {
  let hash = 0;
  for (let i = 0; i < rawLabel.length; i++) {
    hash = (hash * 31 + rawLabel.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const light = document.documentElement.dataset.theme === "light";
  return `hsl(${hue}, 45%, ${light ? 34 : 72}%)`;
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
        className="bg-void text-phosphor border border-line rounded-sm px-1 text-xs w-28 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
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

// One chip per distinct speaker, in order of first appearance.
function distinctSpeakers(segments: TranscriptSegment[]): { raw: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const seg of segments) {
    const raw = seg.raw_speaker ?? seg.speaker;
    if (!raw || seen.has(raw)) continue;
    seen.set(raw, seg.speaker ?? raw);
  }
  return [...seen.entries()].map(([raw, name]) => ({ raw, name }));
}

export const MeetingHeader: React.FC<{
  session: Session;
  tab: MeetingTab;
  onTabChange: (tab: MeetingTab) => void;
}> = ({ session, tab, onTabChange }) => {
  const [speakers, setSpeakers] = useState<{ raw: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setSpeakers([]);
    getSessionTranscript(session.id)
      .then((segments) => {
        if (!cancelled) setSpeakers(distinctSpeakers(segments).slice(0, 4));
      })
      .catch(() => {
        /* chips are an enrichment; the header renders fine without them */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const tabButton = (value: MeetingTab, label: string) => (
    <button
      onClick={() => onTabChange(value)}
      aria-current={tab === value ? "page" : undefined}
      className={
        "px-3 py-1.5 text-xs border-b-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
        (tab === value ? "border-signal text-phosphor" : "border-transparent text-dim hover:text-phosphor")
      }
    >
      {label}
    </button>
  );

  return (
    <div className="shrink-0 px-4 pt-3 border-b border-line">
      <h1 className="text-[15px] font-semibold text-phosphor truncate">{session.title}</h1>
      <div className="mt-1 flex items-center gap-3 flex-wrap">
        <span className="text-[11px] text-dim">{formatRelativeTime(session.created_at)}</span>
        {speakers.map((s) => (
          <span key={s.raw} className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: s.raw === "You" ? undefined : speakerColor(s.raw) }}>
            <span
              aria-hidden="true"
              className={"h-1.5 w-1.5 rounded-full " + (s.raw === "You" ? "bg-phosphor" : "")}
              style={s.raw === "You" ? undefined : { background: speakerColor(s.raw) }}
            />
            <span className={s.raw === "You" ? "text-phosphor" : undefined}>{s.name.toLowerCase()}</span>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-0.5">
        {tabButton("notes", "notes")}
        {tabButton("transcript", "transcript")}
        {tabButton("chat", "chat")}
      </div>
    </div>
  );
};

// ---- notes markdown --------------------------------------------------------
// The notes are model-written markdown from a known, narrow dialect
// (headings, dash bullets, _italic_ explanations, occasional **bold** and
// `code`). Rendering it with a tiny purpose-built renderer -- headings as
// the app's uppercase section labels, bullets as real lists -- beats both
// showing raw "#"/"-" markers (what the old <pre> did) and pulling in a
// general markdown dependency for content we generate ourselves.

type NotesBlock =
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "para"; text: string };

function parseNotesBlocks(notes: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let bullets: string[] | null = null;
  let para: string[] | null = null;

  const flush = () => {
    if (bullets && bullets.length) blocks.push({ kind: "bullets", items: bullets });
    if (para && para.length) blocks.push({ kind: "para", text: para.join(" ") });
    bullets = null;
    para = null;
  };

  for (const rawLine of notes.split("\n")) {
    const line = rawLine.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1].trim() });
    } else if (bullet) {
      if (para) flush();
      (bullets ??= []).push(bullet[1]);
    } else if (line.trim() === "" || /^[-=_*]{3,}$/.test(line.trim())) {
      flush();
    } else {
      if (bullets) flush();
      (para ??= []).push(line.trim());
    }
  }
  flush();

  // The notes open with "# <meeting title>" (or "# Title: ..."), which the
  // meeting header above already shows -- drop that one duplicate.
  if (blocks[0]?.kind === "heading") blocks.shift();
  return blocks;
}

// Inline markdown: **bold**, _italic_/*italic*, `code`. Anything else
// renders literally.
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i} className="font-semibold text-phosphor">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="font-sans text-[12px] bg-panel border border-line/60 rounded-sm px-1">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      ((part.startsWith("_") && part.endsWith("_")) || (part.startsWith("*") && part.endsWith("*"))) &&
      part.length > 2
    ) {
      return <em key={i} className="italic text-dim">{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

const NotesMarkdown: React.FC<{ notes: string }> = ({ notes }) => (
  <div className="flex flex-col gap-3">
    {parseNotesBlocks(notes).map((block, i) => {
      if (block.kind === "heading") {
        return (
          <h3 key={i} className="font-sans text-[10px] uppercase tracking-[0.14em] text-dim mt-2 first:mt-0">
            {block.text}
          </h3>
        );
      }
      if (block.kind === "bullets") {
        return (
          <ul key={i} className="list-disc marker:text-dim pl-5 space-y-1.5 font-reading text-[13px] leading-relaxed text-phosphor">
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ul>
        );
      }
      return (
        <p key={i} className="font-reading text-[13px] leading-relaxed text-phosphor">
          {renderInline(block.text)}
        </p>
      );
    })}
  </div>
);

const ActionItemsChecklist: React.FC<{
  items: ActionItem[];
  checked: Set<number>;
  onToggle: (i: number) => void;
}> = ({ items, checked, onToggle }) => (
  <div>
    <div className="text-[10px] uppercase tracking-[0.14em] text-dim mb-2">action items</div>
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex items-center gap-2.5 text-[13px] font-reading border border-line/60 rounded-sm bg-panel px-2.5 py-1.5"
        >
          <input
            type="checkbox"
            checked={checked.has(i)}
            onChange={() => onToggle(i)}
            aria-label={item.text}
            className="accent-signal"
          />
          <span className={"flex-1 " + (checked.has(i) ? "line-through text-dim" : "text-phosphor")}>
            {item.text}
          </span>
          {item.owner ? <span className="font-sans text-[11px] text-dim shrink-0">{item.owner}</span> : null}
          {item.due ? <span className="font-sans text-[11px] text-dim/70 shrink-0">{item.due}</span> : null}
        </li>
      ))}
    </ul>
  </div>
);

export const NotesPane: React.FC<{ session: Session }> = ({ session }) => {
  const [actionItems, setActionItems] = useState<ActionItem[] | null>(null);
  const [checkedIndexes, setCheckedIndexes] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setActionItems(null);
    setCheckedIndexes(new Set());
    getSessionActionItems(session.id)
      .then((result) => {
        if (!cancelled) setActionItems(result);
      })
      .catch(() => {
        // Same fallback as the backend returning null: prose notes only.
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
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 [-webkit-app-region:no-drag]">
      <div className="max-w-2xl flex flex-col gap-4">
        {actionItems && actionItems.length > 0 ? (
          <ActionItemsChecklist items={actionItems} checked={checkedIndexes} onToggle={toggleChecked} />
        ) : null}
        <NotesMarkdown notes={session.notes} />
      </div>
    </div>
  );
};

export const TranscriptPane: React.FC<{ sessionId: string }> = ({ sessionId }) => {
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
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs text-dim">
        Couldn't load transcript. Try again later.
      </div>
    );
  }

  if (segments === null) {
    return <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs text-dim">Loading transcript...</div>;
  }

  if (segments.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs text-dim">
        No speech was transcribed for this recording.
      </div>
    );
  }

  // The dominant language of the recording; segments in any OTHER
  // language get a small tag (code-switched meetings, 1.2b). Monolingual
  // recordings have at most one language value, so nothing is tagged.
  const languageCounts = new Map<string, number>();
  for (const seg of segments) {
    if (seg.language) languageCounts.set(seg.language, (languageCounts.get(seg.language) ?? 0) + 1);
  }
  const dominantLanguage =
    [...languageCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const languageTag = (seg: TranscriptSegment) =>
    seg.language && seg.language !== dominantLanguage ? (
      <span className="ml-1.5 align-middle font-sans text-[9px] uppercase tracking-[0.08em] text-dim border border-line rounded-sm px-1 py-px">
        {seg.language}
      </span>
    ) : null;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 [-webkit-app-region:no-drag]">
      <div className="max-w-3xl space-y-2.5">
        {renameError && (
          <div role="alert" className="flex items-center justify-between gap-2 text-xs text-red-400">
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
              <p key={i} className="font-reading text-[13px] leading-relaxed text-phosphor">
                {seg.text}
                {languageTag(seg)}
              </p>
            );
          }
          const rawLabel = seg.raw_speaker ?? seg.speaker ?? "Unknown";
          const displayName = nameOverrides[rawLabel] ?? seg.speaker ?? "Unknown";
          const isYou = rawLabel === "You";
          return (
            <div key={i}>
              <span className="text-xs font-semibold">
                <SpeakerLabel
                  displayName={displayName}
                  rawLabel={rawLabel}
                  isYou={isYou}
                  onRename={handleRename}
                />
                {languageTag(seg)}
              </span>
              <p className="mt-0.5 font-reading text-[13px] leading-relaxed text-phosphor">{seg.text}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
