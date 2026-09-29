import React, { useEffect, useRef, useState } from "react";
import { backendFetch, exportSessionNotesUrl, exportSessionZipUrl, type Session } from "../api";

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
async function exportViaFetch(url: string, label: string, onExportError: (message: string) => void) {
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
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
      style={{ left, top, width: MENU_WIDTH }}
      className="fixed z-50 bg-panel border border-line rounded-sm shadow-lg py-1 text-phosphor [-webkit-app-region:no-drag]"
    >
      <button className={itemClass} onClick={() => onOpenNotes(session)}>
        [notes]
      </button>
      <button
        className={itemClass}
        onClick={() => {
          exportViaFetch(exportSessionNotesUrl(session.id), "notes", onExportError);
          onClose();
        }}
      >
        [export notes]
      </button>
      <button
        className={itemClass}
        onClick={() => {
          exportViaFetch(exportSessionZipUrl(session.id), "recording", onExportError);
          onClose();
        }}
      >
        [export recording]
      </button>

      {view === "active" && (
        <>
          <button className={itemClass} onClick={() => onRename(session)}>
            [rename]
          </button>
          <button className={itemClass} onClick={() => onTrash(session)}>
            [trash]
          </button>
        </>
      )}

      {view === "trash" && (
        <>
          <button className={itemClass} onClick={() => onRestore(session)}>
            [restore]
          </button>
          {confirmingDelete ? (
            <div className="px-2 py-1.5 text-xs text-red-400 flex flex-col gap-1">
              <span>delete forever?</span>
              <div className="flex gap-2">
                <button
                  className="text-red-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => onDeleteForever(session)}
                >
                  [confirm]
                </button>
                <button
                  className="text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => setConfirmingDelete(false)}
                >
                  [cancel]
                </button>
              </div>
            </div>
          ) : (
            <button className={itemClass + " hover:text-red-400"} onClick={() => setConfirmingDelete(true)}>
              [delete forever]
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default SessionContextMenu;
