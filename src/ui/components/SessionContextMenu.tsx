import React, { useEffect, useRef, useState } from "react";
import { exportSessionNotesUrl, exportSessionZipUrl, type Session } from "../api";

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
}

const MENU_WIDTH = 180;
const MENU_HEIGHT_ESTIMATE = 200;

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
      <a href={exportSessionNotesUrl(session.id)} download className={itemClass}>
        [export notes]
      </a>
      <a href={exportSessionZipUrl(session.id)} download className={itemClass}>
        [export recording]
      </a>

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
            <div className="px-2 py-1.5 text-xs text-red-400 flex items-center justify-between gap-1">
              <span>delete forever?</span>
              <div className="flex gap-1">
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
