import React, { useEffect } from "react";
import SettingsPage from "./SettingsPage";

interface Props {
  active: boolean;
  onClose: () => void;
}

const SettingsModal: React.FC<Props> = ({ active, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 bg-void/90 flex items-center justify-center px-6 py-6 [-webkit-app-region:no-drag]">
      <div className="relative w-full h-full bg-panel border border-line rounded-sm overflow-hidden flex flex-col">
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="absolute top-2 right-2 z-10 h-6 w-6 grid place-items-center rounded-sm text-dim hover:text-phosphor hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        <SettingsPage active={active} />
      </div>
    </div>
  );
};

export default SettingsModal;
