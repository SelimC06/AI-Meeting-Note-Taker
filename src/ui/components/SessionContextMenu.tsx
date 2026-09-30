import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch, exportSessionNotesUrl, exportSessionZipUrl, type Session } from "../api";
import { isDialogOpen } from "../hooks/useDialog";

interface Props {
  session: Session;
  view: "active" | "trash";
  x: number;
  y: number;
  onClose: () => void;
  onOpenNotes: (session: Session) => void;
  onRename: (session: Session) => void;
  onTrash: (session: Session) => void;
  onRestore: (session: Session) => void;
  onDeleteForever: (session: Session) => void;
  onExportError: (message: string) => void;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT_ESTIMATE = 200;

// A plain <a href download> gives no way to know the request failed --
// with the backend down, clicking export silently did nothing. Fetching it
// ourselves lets a failure surface through onExportError, same as every
// other session action; on success the response becomes a Blob and is
// downloaded through a throwaway object-URL link instead.
// Exports in flight, as "<sessionId>:<kind>". Module-level, not component
// state: the menu closes the moment an export starts, and a recording's zip
// can take minutes -- reopening the menu then showed a fresh "[export
// recording]" and a second click started a second multi-GB download of the
// same thing. Now that item shows "exporting…" and does nothing until the
// first one finishes.
const exportsInFlight = new Set<string>();
const exportListeners = new Set<() => void>();
let exportsVersion = 0;

function setExporting(key: string, exporting: boolean) {
  if (exporting) exportsInFlight.add(key);
  else exportsInFlight.delete(key);
  exportsVersion += 1;
  exportListeners.forEach((listener) => listener());
}

function subscribeToExports(listener: () => void) {
  exportListeners.add(listener);
  return () => {
    exportListeners.delete(listener);
  };
}

function useExportsVersion() {
  return useSyncExternalStore(subscribeToExports, () => exportsVersion);
}

async function exportViaFetch(url: string, label: string, onExportError: (message: string) => void, key: string) {
  if (exportsInFlight.has(key)) return;
  setExporting(key, true);
  try {
    // backendFetch, not fetch: the export endpoints need the API token too
    // (another reason a plain <a href> can't work -- it can't send headers).
    const resp = await backendFetch(url);
    if (!resp.ok) {
      onExportError(`Couldn't export ${label} — request failed: ${resp.status}`);
      return;
    }
    const blob = await resp.blob();
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filenameMatch?.[1] ?? label;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (e) {
    const detail = e instanceof TypeError ? "backend offline" : e instanceof Error ? e.message : String(e);
    onExportError(`Couldn't export ${label} — ${detail}`);
  } finally {
    setExporting(key, false);
  }
}

const SessionContextMenu: React.FC<Props> = ({
  session,
  view,
  x,
  y,
  onClose,
  onOpenNotes,
  onRename,
  onTrash,
  onRestore,
  onDeleteForever,
  onExportError,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useExportsVersion(); // re-render when an export starts or finishes
  const notesKey = `${session.id}:notes`;
  const recordingKey = `${session.id}:recording`;
  const exportingNotes = exportsInFlight.has(notesKey);
  const exportingRecording = exportsInFlight.has(recordingKey);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard users arrive here from a row's "⋯" button or the context-menu
  // key: focus the first item on open, and hand focus back to whatever
  // opened the menu when it closes -- but only if focus would otherwise be
  // lost (an item was focused when the menu went away), never pulling it
  // back from a rename input or a dialog the chosen action just opened.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    menuItems()[0]?.focus();
    return () => {
      const active = document.activeElement;
      if ((active === null || active === document.body) && opener?.isConnected) opener.focus();
    };
  }, []);

  // The "[delete forever]" item is replaced by the confirm step; without
  // this, focus fell out of the menu entirely when it disappeared. Lands on
  // [cancel], not [confirm] -- the delete is permanent.
  useEffect(() => {
    if (confirmingDelete) cancelDeleteRef.current?.focus();
  }, [confirmingDelete]);

  function menuItems(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  // Standard menu keys: arrows move (wrapping), Home/End jump, Tab leaves
  // the menu (closing it, like a native one). Escape is handled below with
  // the outside-click close.
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
    else if (e.key === "ArrowUp") next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  };

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (menuRef.current?.contains(target)) return;
      // The row's own "⋯" button toggles the menu itself (Sidebar) --
      // closing here first would make its click reopen it.
      if (target?.closest?.("[data-session-menu-trigger]")) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // A dialog opened over the menu (e.g. the recording-consent notice)
      // owns Escape -- one press used to answer it AND close the menu.
      if (e.key === "Escape" && !isDialogOpen()) onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT_ESTIMATE));

  const itemClass =
    "block w-full text-left px-2 py-1.5 text-xs text-dim hover:text-phosphor hover:bg-line transition focus:outline-none focus-visible:ring-2 focus-visible:ring-signal";

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${session.title}`}
      onKeyDown={handleMenuKeyDown}
      style={{ left, top, width: MENU_WIDTH }}
      className="fixed z-50 bg-panel border border-line rounded-sm shadow-lg py-1 text-phosphor [-webkit-app-region:no-drag]"
    >
      <button role="menuitem" tabIndex={-1} className={itemClass} onClick={() => onOpenNotes(session)}>
        [notes]
      </button>
      <button
        role="menuitem"
        tabIndex={-1}
        aria-disabled={exportingNotes || undefined}
        className={itemClass + (exportingNotes ? " cursor-default" : "")}
        onClick={() => {
          if (exportingNotes) return;
          exportViaFetch(exportSessionNotesUrl(session.id), "notes", onExportError, notesKey);
          onClose();
        }}
      >
        {exportingNotes ? "[exporting notes…]" : "[export notes]"}
      </button>
      <button
        role="menuitem"
        tabIndex={-1}
        aria-disabled={exportingRecording || undefined}
        className={itemClass + (exportingRecording ? " cursor-default" : "")}
        onClick={() => {
          if (exportingRecording) return;
          exportViaFetch(exportSessionZipUrl(session.id), "recording", onExportError, recordingKey);
          onClose();
        }}
      >
        {exportingRecording ? "[exporting recording…]" : "[export recording]"}
      </button>

      {view === "active" && (
        <>
          <button role="menuitem" tabIndex={-1} className={itemClass} onClick={() => onRename(session)}>
            [rename]
          </button>
          <button role="menuitem" tabIndex={-1} className={itemClass} onClick={() => onTrash(session)}>
            [trash]
          </button>
        </>
      )}

      {view === "trash" && (
        <>
          <button role="menuitem" tabIndex={-1} className={itemClass} onClick={() => onRestore(session)}>
            [restore]
          </button>
          {confirmingDelete ? (
            <div role="group" aria-label="delete forever?" className="px-2 py-1.5 text-xs text-red-400 flex flex-col gap-1">
              <span aria-hidden="true">delete forever?</span>
              <div className="flex gap-2">
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="text-red-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => onDeleteForever(session)}
                >
                  [confirm]
                </button>
                <button
                  ref={cancelDeleteRef}
                  role="menuitem"
                  tabIndex={-1}
                  className="text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => setConfirmingDelete(false)}
                >
                  [cancel]
                </button>
              </div>
            </div>
          ) : (
            <button
              role="menuitem"
              tabIndex={-1}
              className={itemClass + " hover:text-red-400"}
              onClick={() => setConfirmingDelete(true)}
            >
              [delete forever]
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default SessionContextMenu;
