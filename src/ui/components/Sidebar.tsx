// src/ui/components/Sidebar.tsx
import React, { useEffect, useRef, useState } from "react";
import {
  trashSession,
  restoreSession,
  deleteSessionForever,
  renameSession,
  type Session,
} from "../api";
import { useSessions } from "../hooks/useSessions";
import { useProcessingJobs } from "../hooks/useProcessingJobs";
import SessionContextMenu from "./SessionContextMenu";
import NotesModal from "./NotesModal";
import DockedRail from "./DockedRail";
import { formatRelativeTime } from "../utils/formatRelativeTime";

type View = "active" | "trash";

interface Props {
  view: View;
  collapsed: boolean;
  sessions: Session[] | null;
  sessionsError: string | null;
  reloadSessions: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const Sidebar: React.FC<Props> = ({
  view,
  collapsed,
  sessions,
  sessionsError,
  reloadSessions,
  selectedId,
  onSelect,
}) => {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [undoToast, setUndoToast] = useState<{ id: string; title: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [notesSession, setNotesSession] = useState<Session | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trashList = useSessions(view === "trash", true);

  const { jobs } = useProcessingJobs();
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const reloadedForRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const justFinished = jobs.filter(
      (j) => (j.status === "done" || j.status === "failed") && !reloadedForRef.current.has(j.id)
    );
    if (justFinished.length > 0) {
      justFinished.forEach((j) => reloadedForRef.current.add(j.id));
      reloadSessions();
    }
  }, [jobs, reloadSessions]);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current !== null) clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  // Clears any per-view UI state left over from the other view (an open
  // context menu, a pending undo toast, an in-progress rename) whenever the
  // status line's active/trash buttons switch which list is shown.
  useEffect(() => {
    setQuery("");
    setContextMenu(null);
    setUndoToast(null);
    if (undoTimeoutRef.current !== null) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
  }, [view]);

  const list = view === "trash" ? trashList.sessions : sessions;
  const listError = view === "trash" ? trashList.error : sessionsError;
  const filtered =
    list?.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())) ?? null;

  const handleTrash = async (s: Session) => {
    setContextMenu(null);
    if (selectedId === s.id) onSelect(null);
    try {
      await trashSession(s.id);
      reloadSessions();
      setUndoToast({ id: s.id, title: s.title });
      if (undoTimeoutRef.current !== null) clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = setTimeout(() => {
        setUndoToast((cur) => (cur?.id === s.id ? null : cur));
        undoTimeoutRef.current = null;
      }, 6000);
    } catch (e) {
      console.error("[Sidebar] trash failed:", e);
      reloadSessions();
    }
  };

  const handleUndo = async (id: string) => {
    setUndoToast(null);
    try {
      await restoreSession(id);
    } catch (e) {
      console.error("[Sidebar] undo failed:", e);
    }
    reloadSessions();
  };

  const handleRestore = async (s: Session) => {
    setContextMenu(null);
    try {
      await restoreSession(s.id);
    } catch (e) {
      console.error("[Sidebar] restore failed:", e);
    }
    trashList.reload();
    reloadSessions();
  };

  const handleDeleteForever = async (s: Session) => {
    setContextMenu(null);
    if (selectedId === s.id) onSelect(null);
    try {
      await deleteSessionForever(s.id);
    } catch (e) {
      console.error("[Sidebar] delete forever failed:", e);
    }
    trashList.reload();
  };

  const startRename = (s: Session) => {
    setContextMenu(null);
    setRenamingId(s.id);
    setRenameValue(s.title);
  };

  const commitRename = async (id: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await renameSession(id, title);
    } catch (e) {
      console.error("[Sidebar] rename failed:", e);
    }
    reloadSessions();
  };

  const hasList = list !== null && list.length > 0;

  // "done" (or a pre-status-field record, where status is undefined) needs
  // no badge -- only the degraded cases (job failed but the recording was
  // preserved, or a directory recovered from an interrupted/crashed run)
  // are worth calling out.
  const statusBadge = (s: Session) => {
    if (s.status === "failed") {
      return (
        <span
          role="img"
          aria-label="Processing failed"
          title={s.error ? `Processing failed: ${s.error}` : "Processing failed"}
          className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 align-middle"
        />
      );
    }
    if (s.status === "recovered") {
      return (
        <span
          role="img"
          aria-label="Recovered recording"
          title="Recovered after an interrupted recording (e.g. an app crash or restart)"
          className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 align-middle"
        />
      );
    }
    return null;
  };

  return (
    <>
      <div
        inert={collapsed ? true : undefined}
        className={
          "shrink-0 h-full overflow-hidden transition-all duration-200 " +
          (collapsed ? "w-0" : "w-56")
        }
      >
        <div className="w-56 h-full flex flex-col border-r border-line bg-panel text-phosphor [-webkit-app-region:no-drag]">
          <div className="p-2 border-b border-line flex flex-col gap-2">
            <DockedRail />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search meetings..."
              aria-label="Search meetings"
              className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor placeholder:text-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            />
          </div>

          {undoToast && (
            <div className="flex items-center justify-between px-2 py-1.5 text-xs bg-void border-b border-signal">
              <span className="truncate">trashed "{undoToast.title}"</span>
              <button
                onClick={() => handleUndo(undoToast.id)}
                className="text-signal hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal shrink-0 ml-1"
              >
                [undo]
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto">
            {view === "active" && query.trim() === "" && activeJobs.length > 0 && (
              <ul className="divide-y divide-line border-b border-line">
                {activeJobs.map((j) => (
                  <li key={`job-${j.id}`} className="px-2 py-2 text-xs text-dim flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-signal cursor-blink shrink-0" aria-hidden="true" />
                    <span className="truncate">processing{j.stage ? ` — ${j.stage}` : "…"}</span>
                  </li>
                ))}
              </ul>
            )}

            {listError && <div className="p-3 text-xs text-red-400">failed to load: {listError}</div>}

            {!listError && list === null && (
              <div className="p-3 text-xs text-dim">
                loading<span className="cursor-blink">▌</span>
              </div>
            )}

            {!listError && list !== null && list.length === 0 && (
              <div className="p-3 text-xs text-dim">
                {view === "trash" ? "trash is empty" : "no meetings recorded yet"}
              </div>
            )}

            {!listError && hasList && filtered !== null && filtered.length === 0 && (
              <div className="p-3 text-xs text-dim">{`no matches for "${query}"`}</div>
            )}

            {!listError && filtered !== null && filtered.length > 0 && (
              <ul className="divide-y divide-line">
                {filtered.map((s) => (
                  <li key={s.id}>
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(s.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="w-full bg-void border border-signal rounded-sm px-2 py-2 text-xs text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                      />
                    ) : view === "active" ? (
                      <button
                        onClick={() => onSelect(s.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ session: s, x: e.clientX, y: e.clientY });
                        }}
                        title={s.title}
                        className={
                          "w-full text-left text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                          (selectedId === s.id
                            ? "bg-line border-l-2 border-signal pl-[6px] pr-2 py-2"
                            : "px-2 py-2 hover:bg-line")
                        }
                      >
                        <div className="flex items-center">
                          <span className="truncate">{s.title}</span>
                          {statusBadge(s)}
                        </div>
                        <div className="text-dim">{formatRelativeTime(s.created_at)}</div>
                      </button>
                    ) : (
                      <div
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ session: s, x: e.clientX, y: e.clientY });
                        }}
                        title={s.title}
                        className="w-full text-left px-2 py-2 text-xs"
                      >
                        <div className="flex items-center">
                          <span className="truncate">{s.title}</span>
                          {statusBadge(s)}
                        </div>
                        <div className="text-dim">{formatRelativeTime(s.trashed_at ?? s.created_at)}</div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {contextMenu && (
        <SessionContextMenu
          session={contextMenu.session}
          view={view}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpenNotes={(s) => {
            setContextMenu(null);
            setNotesSession(s);
          }}
          onRename={startRename}
          onTrash={handleTrash}
          onRestore={handleRestore}
          onDeleteForever={handleDeleteForever}
        />
      )}

      {notesSession && <NotesModal session={notesSession} onClose={() => setNotesSession(null)} />}
    </>
  );
};

export default Sidebar;
