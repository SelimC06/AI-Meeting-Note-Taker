import React, { useEffect, useState } from "react";
import {
  getSessions,
  trashSession,
  restoreSession,
  deleteSessionForever,
  renameSession,
  exportSessionNotesUrl,
  exportSessionZipUrl,
  type Session,
} from "../api";

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

interface Props {
  active: boolean;
}

type View = "active" | "trash";

const YourActivityPage: React.FC<Props> = ({ active }) => {
  const [view, setView] = useState<View>("active");
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const load = () => {
    getSessions(view === "trash")
      .then((data) => {
        const filtered = view === "trash" ? data.filter((s) => s.trashed_at) : data;
        setSessions(filtered);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getSessions(view === "trash")
      .then((data) => {
        if (cancelled) return;
        const filtered = view === "trash" ? data.filter((s) => s.trashed_at) : data;
        setSessions(filtered);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [active, view]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  const switchView = (next: View) => {
    setView(next);
    setSelectedId(null);
    setSessions(null);
  };

  const handleTrash = async (s: Session) => {
    setSessions((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
    if (selectedId === s.id) setSelectedId(null);
    try {
      await trashSession(s.id);
      setUndoToast({ id: s.id, title: s.title });
      setTimeout(() => {
        setUndoToast((cur) => (cur?.id === s.id ? null : cur));
      }, 6000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const handleUndo = async (id: string) => {
    setUndoToast(null);
    try {
      await restoreSession(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRestore = async (s: Session) => {
    setSessions((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
    try {
      await restoreSession(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const handleDeleteForever = async (id: string) => {
    try {
      await deleteSessionForever(id);
      setConfirmDeleteId(null);
      setSessions((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startRename = (s: Session) => {
    setRenamingId(s.id);
    setRenameValue(s.title);
  };

  const commitRename = async (id: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    const prevSessions = sessions;
    setSessions((prev) => (prev ? prev.map((s) => (s.id === id ? { ...s, title } : s)) : prev));
    try {
      await renameSession(id, title);
    } catch (e) {
      setSessions(prevSessions);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-sm font-semibold tracking-wide uppercase">[ACTIVITY]</h1>
          <p className="text-xs text-dim">
            recent meetings and notes captured by the app
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => switchView("active")}
            className={
              "px-2 py-1 rounded-sm text-xs transition focus:outline-none focus:ring-2 focus:ring-signal " +
              (view === "active" ? "bg-signal text-void" : "text-dim hover:text-phosphor border border-line")
            }
          >
            [active]
          </button>
          <button
            onClick={() => switchView("trash")}
            className={
              "px-2 py-1 rounded-sm text-xs transition focus:outline-none focus:ring-2 focus:ring-signal " +
              (view === "trash" ? "bg-signal text-void" : "text-dim hover:text-phosphor border border-line")
            }
          >
            [trash]
          </button>
        </div>
      </div>

      {undoToast && (
        <div className="flex items-center justify-between px-3 py-2 text-xs bg-panel border border-signal rounded-sm">
          <span>trashed "{undoToast.title}"</span>
          <button
            onClick={() => handleUndo(undoToast.id)}
            className="text-signal hover:underline focus:outline-none"
          >
            [undo]
          </button>
        </div>
      )}

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
            {view === "trash" ? "trash is empty" : "no meetings recorded yet"}
            <span className="cursor-blink">▌</span>
          </div>
        )}

        {!error && sessions !== null && sessions.length > 0 && !selected && (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-2 text-xs group">
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
                    className="flex-1 bg-void border border-signal rounded-sm px-1 py-0.5 text-xs text-phosphor focus:outline-none"
                  />
                ) : (
                  <button
                    onClick={() => setSelectedId(s.id)}
                    className="flex-1 text-left hover:bg-signal hover:text-void px-1 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal"
                  >
                    [{formatRelativeTime(view === "trash" ? (s.trashed_at ?? s.created_at) : s.created_at)}] {s.title}
                  </button>
                )}

                {view === "active" && renamingId !== s.id && (
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={() => startRename(s)}
                      className="text-dim hover:text-phosphor px-1.5 py-0.5 rounded-sm focus:outline-none focus:ring-2 focus:ring-signal"
                    >
                      [rename]
                    </button>
                    <button
                      onClick={() => handleTrash(s)}
                      className="text-dim hover:text-red-400 px-1.5 py-0.5 rounded-sm focus:outline-none focus:ring-2 focus:ring-signal"
                    >
                      [trash]
                    </button>
                  </div>
                )}

                {view === "trash" && (
                  <div className="flex gap-1 items-center">
                    <button
                      onClick={() => handleRestore(s)}
                      className="text-dim hover:text-phosphor px-1.5 py-0.5 rounded-sm focus:outline-none focus:ring-2 focus:ring-signal"
                    >
                      [restore]
                    </button>
                    {confirmDeleteId === s.id ? (
                      <>
                        <span className="text-red-400">delete forever?</span>
                        <button
                          onClick={() => handleDeleteForever(s.id)}
                          className="text-red-400 hover:underline focus:outline-none"
                        >
                          [confirm]
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-dim hover:text-phosphor focus:outline-none"
                        >
                          [cancel]
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(s.id)}
                        className="text-dim hover:text-red-400 px-1.5 py-0.5 rounded-sm focus:outline-none focus:ring-2 focus:ring-signal"
                      >
                        [delete forever]
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {!error && selected && (
          <div className="h-full flex flex-col">
            <div className="px-4 py-2 border-b border-line flex items-center justify-between text-xs">
              <span>{selected.title}</span>
              <div className="flex gap-2 items-center">
                <a
                  href={exportSessionNotesUrl(selected.id)}
                  download
                  className="text-dim hover:bg-signal hover:text-void px-1.5 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal"
                >
                  [export notes]
                </a>
                <a
                  href={exportSessionZipUrl(selected.id)}
                  download
                  className="text-dim hover:bg-signal hover:text-void px-1.5 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal"
                >
                  [export recording]
                </a>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-dim hover:bg-signal hover:text-void px-1.5 py-0.5 rounded-sm transition focus:outline-none focus:ring-2 focus:ring-signal"
                >
                  [back]
                </button>
              </div>
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
