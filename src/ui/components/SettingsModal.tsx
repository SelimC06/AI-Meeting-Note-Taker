import React, { useEffect } from "react";
import SettingsPage from "./SettingsPage";

interface Props {
  active: boolean;
  onClose: () => void;
  onSessionsDeleted?: (ids: string[]) => void;
}

const SettingsModal: React.FC<Props> = ({ active, onClose, onSessionsDeleted }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 bg-void/85 flex items-center justify-center p-6 [-webkit-app-region:no-drag]">
      <div className="relative w-full max-w-3xl h-full max-h-[38rem] bg-panel border border-line rounded-sm overflow-hidden flex flex-col shadow-[0_40px_90px_-20px_rgba(0,0,0,0.7)]">
        <div className="shrink-0 flex items-baseline justify-between gap-3 px-4 py-2 border-b border-line">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-xs font-semibold tracking-wide uppercase text-phosphor shrink-0">[SETTINGS]</h1>
            <p className="text-[11px] text-dim truncate">transcription, storage, and chat preferences</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="shrink-0 h-5 w-5 grid place-items-center rounded-sm text-dim hover:text-phosphor hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </div>
        <SettingsPage active={active} onSessionsDeleted={onSessionsDeleted} />
      </div>
    </div>
  );
};

export default SettingsModal;
