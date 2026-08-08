import React, { useEffect } from "react";
import type { Session } from "../api";

interface Props {
  session: Session;
  onClose: () => void;
}

const NotesModal: React.FC<Props> = ({ session, onClose }) => {
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
        <pre className="flex-1 overflow-y-auto px-3 py-2 text-xs whitespace-pre-wrap text-phosphor">
          {session.notes}
        </pre>
      </div>
    </div>
  );
};

export default NotesModal;
