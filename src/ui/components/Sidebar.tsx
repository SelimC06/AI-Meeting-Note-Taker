// src/ui/components/Sidebar.tsx
import React, { useEffect, useRef, useState } from "react";
import {
  trashSession,
  restoreSession,
  deleteSessionForever,
  renameSession,
  recoverSessionsIndex,
  importRecording,
  IMPORT_FILE_EXTENSIONS,
  type Session,
} from "../api";
import { useSessions } from "../hooks/useSessions";
import { useProcessingJobs } from "../hooks/useProcessingJobs";
import SessionContextMenu from "./SessionContextMenu";
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
  // Invoked with a session's id right after it's permanently deleted (not
  // trashed -- trashing is reversible via the undo toast, so it must NOT
  // fire this). Lets a caller above (App.tsx) discard any chat state kept
  // for that session instead of leaking a dead session id in memory.
  // Optional so existing tests/callers that don't track chat state don't
  // need it.
  onSessionDeleted?: (id: string) => void;
  // False only during the brief window before the backend lifecycle first
  // reports healthy (cold start, or a restart in progress) -- useSessions'
  // very first fetch lands as connection-refused in that window, and
  // without this the sidebar showed "failed to load" instead of a neutral
  // loading state on every single launch (G9). Defaults true so callers
  // that don't care about the distinction (most tests) keep the original
  // always-show-errors behavior.
  backendUp?: boolean;
  // True once the backend lifecycle has reported 'failed' -- see Chat's
  // identically-named prop. Without this, a backend that never comes up
  // keeps backendUp false forever and the sidebar shows "loading" forever
  // instead of ever surfacing the real error (re-review-12-13 H1/L1).
  // Defaults false.
  backendFailed?: boolean;
  // True when sessionsError is the backend's damaged-index error (see
  // useSessions' indexCorrupt) -- shows a "recover library" action next to
  // it. Defaults false.
  sessionsIndexCorrupt?: boolean;
  // Bumped by App when sessions were permanently deleted from outside this
  // component (Settings' Empty Trash) -- the trash list is this
  // component's own fetch, so it has to be told to refetch.
  trashRefreshKey?: number;
}

// Distinguishes "the fetch itself never landed" (offline/backend down --
// browsers throw a bare TypeError for that, e.g. Chromium's "Failed to
// fetch") from a request that reached the backend and got a real HTTP error
// back (api.ts already builds a descriptive Error for those), so the banner
// can say something more useful than a generic failure.
function describeActionError(action: string, e: unknown): string {
  if (e instanceof TypeError) {
    return `Couldn't ${action} — backend offline`;
  }
  const detail = e instanceof Error ? e.message : String(e);
  return `Couldn't ${action} — ${detail}`;
}

const ACTION_ERROR_AUTO_DISMISS_MS = 6000;

const Sidebar: React.FC<Props> = ({
  view,
  collapsed,
  sessions,
  sessionsError,
  reloadSessions,
  selectedId,
  onSelect,
  onSessionDeleted,
  backendUp = true,
  backendFailed = false,
  sessionsIndexCorrupt = false,
  trashRefreshKey = 0,
}) => {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [undoToast, setUndoToast] = useState<{ id: string; title: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      // Success needs no further handling here: the job lands in the
      // processing list via the normal jobs polling, and the finished
      // session appears through the same justFinished reload as a
      // recorded meeting.
      await importRecording(file);
    } catch (err) {
      showActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const showActionError = (message: string) => {
    setActionError(message);
    if (actionErrorTimeoutRef.current !== null) clearTimeout(actionErrorTimeoutRef.current);
    actionErrorTimeoutRef.current = setTimeout(() => {
      setActionError(null);
      actionErrorTimeoutRef.current = null;
    }, ACTION_ERROR_AUTO_DISMISS_MS);
  };

  const trashList = useSessions(view === "trash", true);
  const reloadTrash = trashList.reload;
  const lastTrashRefreshKeyRef = useRef(trashRefreshKey);
  useEffect(() => {
    if (trashRefreshKey === lastTrashRefreshKeyRef.current) return;
    lastTrashRefreshKeyRef.current = trashRefreshKey;
    reloadTrash();
  }, [trashRefreshKey, reloadTrash]);

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
      if (actionErrorTimeoutRef.current !== null) clearTimeout(actionErrorTimeoutRef.current);
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
  // Suppressed while the backend isn't known healthy yet -- an error from
  // that window is almost certainly just "not up yet", and the existing
  // reload-on-health-flip effect in App.tsx already recovers it once the
  // backend comes up. Falls through to the "loading" branch below instead
  // (list is still null at that point too). Once the lifecycle has reported
  // 'failed', though, backendUp will never become true on its own, so the
  // suppression is lifted and the real error (if any) is shown instead of
  // loading forever (re-review-12-13 H1/L1).
  const listError = backendUp || backendFailed ? (view === "trash" ? trashList.error : sessionsError) : null;
  const listIndexCorrupt = view === "trash" ? trashList.indexCorrupt : sessionsIndexCorrupt;
  const filtered =
    list?.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())) ?? null;

  const handleTrash = async (s: Session) => {
    setContextMenu(null);
    const wasSelected = selectedId === s.id;
    if (wasSelected) onSelect(null);
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
      if (wasSelected) onSelect(s.id);
      showActionError(describeActionError("move to trash", e));
    }
  };

  const handleUndo = async (id: string, title: string) => {
    setUndoToast(null);
    try {
      await restoreSession(id);
      reloadSessions();
    } catch (e) {
      console.error("[Sidebar] undo failed:", e);
      setUndoToast({ id, title });
      showActionError(describeActionError("undo trash", e));
    }
  };

  const handleRestore = async (s: Session) => {
    setContextMenu(null);
    try {
      await restoreSession(s.id);
      trashList.reload();
      reloadSessions();
    } catch (e) {
      console.error("[Sidebar] restore failed:", e);
      showActionError(describeActionError("restore", e));
    }
  };

  const handleDeleteForever = async (s: Session) => {
    setContextMenu(null);
    const wasSelected = selectedId === s.id;
    if (wasSelected) onSelect(null);
    try {
      await deleteSessionForever(s.id);
      trashList.reload();
      onSessionDeleted?.(s.id);
    } catch (e) {
      console.error("[Sidebar] delete forever failed:", e);
      if (wasSelected) onSelect(s.id);
      showActionError(describeActionError("delete", e));
    }
  };

  const handleRecoverLibrary = async () => {
    setRecovering(true);
    try {
      await recoverSessionsIndex();
    } catch (e) {
      console.error("[Sidebar] recover library failed:", e);
      showActionError(describeActionError("recover library", e));
    } finally {
      setRecovering(false);
      // Both lists read the same index, so both need refetching.
      reloadSessions();
      trashList.reload();
    }
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
      reloadSessions();
    } catch (e) {
      console.error("[Sidebar] rename failed:", e);
      showActionError(describeActionError("rename", e));
    }
  };

  const hasList = list !== null && list.length > 0;

  // Opens the session actions menu at the pointer for a right-click, or
  // under the element for a keyboard-triggered one (the context-menu key /
  // Shift+F10 fire contextmenu with no meaningful pointer position).
  const openMenuFromContextEvent = (e: React.MouseEvent<HTMLElement>, s: Session) => {
    e.preventDefault();
    if (e.clientX === 0 && e.clientY === 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu({ session: s, x: rect.left, y: rect.bottom });
      return;
    }
    setContextMenu({ session: s, x: e.clientX, y: e.clientY });
  };

  // The visible way into the same menu right-click opens -- rows used to
  // have no keyboard (or discoverable) path to rename/trash/notes/export,
  // or, in the trash, to restore/delete at all. Toggles, so a second click
  // closes it.
  const actionsButton = (s: Session) => {
    const open = contextMenu?.session.id === s.id;
    return (
      <button
        data-session-menu-trigger
        aria-label={`Actions for ${s.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          if (open) {
            setContextMenu(null);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setContextMenu({ session: s, x: rect.left, y: rect.bottom });
        }}
        className="absolute right-1 top-1.5 h-5 w-5 grid place-items-center rounded-sm text-dim hover:text-phosphor hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        <span aria-hidden="true">⋯</span>
      </button>
    );
  };

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
            <DockedRail collapsed={collapsed} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search meetings..."
              aria-label="Search meetings"
              className="bg-void border border-line rounded-sm text-xs px-2 py-1 text-phosphor placeholder:text-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            />
            <input
              ref={importInputRef}
              type="file"
              accept={IMPORT_FILE_EXTENSIONS.join(",")}
              onChange={handleImportFile}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className="text-left text-xs px-2 py-1 rounded-sm border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? "importing…" : "[+] import recording"}
            </button>
          </div>

          {actionError && (
            <div className="flex items-center justify-between px-2 py-1.5 text-xs bg-void border-b border-red-500 text-red-400">
              <span className="truncate">{actionError}</span>
              <button
                aria-label="dismiss error"
                onClick={() => {
                  setActionError(null);
                  if (actionErrorTimeoutRef.current !== null) {
                    clearTimeout(actionErrorTimeoutRef.current);
                    actionErrorTimeoutRef.current = null;
                  }
                }}
                className="text-red-400 hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal shrink-0 ml-1"
              >
                [x]
              </button>
            </div>
          )}

          {undoToast && (
            <div className="flex items-center justify-between px-2 py-1.5 text-xs bg-void border-b border-signal">
              <span className="truncate">trashed "{undoToast.title}"</span>
              <button
                onClick={() => handleUndo(undoToast.id, undoToast.title)}
                className="text-signal hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal shrink-0 ml-1"
              >
                [undo]
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto">
            {view === "active" && list !== null && list.length > 0 && (
              <button
                onClick={() => onSelect(null)}
                className={
                  "w-full text-left text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal border-b border-line " +
                  (selectedId === null
                    ? "bg-line px-2 py-2 text-phosphor"
                    : "px-2 py-2 text-dim hover:bg-line")
                }
              >
                <span className="text-signal">✦</span> all meetings
              </button>
            )}

            {view === "active" && query.trim() === "" && activeJobs.length > 0 && (
              <ul className="divide-y divide-line border-b border-line">
                {activeJobs.map((j) => (
                  <li key={`job-${j.id}`} className="px-2 py-2 text-xs text-dim flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-signal cursor-blink shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      processing{j.stage ? ` — ${j.stage}` : "…"}
                      {j.progress ? ` ${j.progress.done}/${j.progress.total}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {listError && <div className="p-3 text-xs text-red-400">failed to load: {listError}</div>}

            {listError && listIndexCorrupt && (
              <div className="px-3 pb-3 text-xs">
                <button
                  onClick={handleRecoverLibrary}
                  disabled={recovering}
                  className="text-signal hover:underline disabled:text-dim disabled:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                  {recovering ? "recovering…" : "[recover library]"}
                </button>
              </div>
            )}

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
                      <div className="relative">
                        <button
                          onClick={() => onSelect(s.id)}
                          onContextMenu={(e) => openMenuFromContextEvent(e, s)}
                          aria-current={selectedId === s.id ? "true" : undefined}
                          title={s.title}
                          className={
                            "w-full text-left text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal " +
                            (selectedId === s.id
                              ? "bg-line border-l-2 border-signal pl-[6px] pr-7 py-2"
                              : "pl-2 pr-7 py-2 hover:bg-line")
                          }
                        >
                          <div className="flex items-center">
                            <span className="truncate">{s.title}</span>
                            {statusBadge(s)}
                          </div>
                          <div className="text-dim">{formatRelativeTime(s.created_at)}</div>
                        </button>
                        {actionsButton(s)}
                      </div>
                    ) : (
                      <div className="relative">
                        {/* A trashed meeting's only actions are in the menu
                            (restore, delete forever, notes, export), so
                            activating the row opens it -- it used to be a
                            plain div reachable only by right-click. */}
                        <button
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setContextMenu({ session: s, x: rect.left, y: rect.bottom });
                          }}
                          onContextMenu={(e) => openMenuFromContextEvent(e, s)}
                          aria-haspopup="menu"
                          title={s.title}
                          className="w-full text-left pl-2 pr-7 py-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                        >
                          <div className="flex items-center">
                            <span className="truncate">{s.title}</span>
                            {statusBadge(s)}
                          </div>
                          <div className="text-dim">{formatRelativeTime(s.trashed_at ?? s.created_at)}</div>
                        </button>
                        {actionsButton(s)}
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
          onRename={startRename}
          onTrash={handleTrash}
          onRestore={handleRestore}
          onDeleteForever={handleDeleteForever}
          onExportError={showActionError}
        />
      )}

    </>
  );
};

export default Sidebar;
