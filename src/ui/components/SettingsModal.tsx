import React from "react";
import SettingsPage from "./SettingsPage";
import { useDialog } from "../hooks/useDialog";

interface Props {
  active: boolean;
  onClose: () => void;
  onSessionsDeleted?: (ids: string[]) => void;
  onLibraryChanged?: () => void;
}

const SettingsModal: React.FC<Props> = ({ active, onClose, onSessionsDeleted, onLibraryChanged }) => {
  const { dialogProps, titleId } = useDialog({ onEscape: onClose });

  return (
    // UI refresh: settings is a full screen over the main row (the title
    // bar and status line stay visible), not a floating box -- the content
    // outgrew a dialog, and a full surface reads as "a place in the app".
    <div className="absolute inset-0 z-50 bg-void [-webkit-app-region:no-drag]">
      <div
        {...dialogProps}
        className="relative w-full h-full bg-void overflow-hidden flex flex-col focus:outline-none"
      >
        <div className="shrink-0 flex items-baseline justify-between gap-3 px-4 py-2 border-b border-line">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 id={titleId} className="text-xs font-semibold tracking-wide uppercase text-phosphor shrink-0">
              [SETTINGS]
            </h1>
            <p className="text-[11px] text-dim truncate">transcription, storage, and chat preferences</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="shrink-0 px-2 py-0.5 rounded-sm border border-line text-[11px] text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            esc · close
          </button>
        </div>
        <SettingsPage active={active} onSessionsDeleted={onSessionsDeleted} onLibraryChanged={onLibraryChanged} />
      </div>
    </div>
  );
};

export default SettingsModal;
