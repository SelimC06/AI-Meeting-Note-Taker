import { useRef } from "react";
import { useDialog } from "../hooks/useDialog";

interface Props {
  onCancel: () => void;
  onConfirm: () => void;
}

export default function RecordingConsentModal({ onCancel, onConfirm }: Props) {
  const isMac = window.electronAPI?.platform === "darwin";
  // Starts on the confirm button: the user just clicked Record (in the rail
  // window -- main brings this window forward for the notice), so Enter
  // continues what they were doing and Escape backs out.
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const { dialogProps, titleId } = useDialog({ onEscape: onCancel, initialFocusRef: confirmRef });

  return (
    <div className="absolute inset-0 z-50 bg-void/90 flex items-center justify-center px-6 py-6 [-webkit-app-region:no-drag]">
      <div
        {...dialogProps}
        className="w-full max-w-sm bg-panel border border-line rounded-sm p-5 flex flex-col gap-3 focus:outline-none"
      >
        <p className="text-[10px] uppercase tracking-widest text-dim">before your first recording</p>
        <h2 id={titleId} className="text-sm font-semibold text-phosphor leading-snug">
          Let people know they're being recorded.
        </h2>
        <p className="text-xs text-dim leading-relaxed">
          This app never uploads anything — but recording someone without telling them can still
          break their trust, or the law, depending on where you are. Give participants a heads-up
          before you hit record.
        </p>
        {isMac && (
          <p className="text-xs text-dim leading-relaxed">
            macOS will also ask you to grant Screen Recording permission the first time you
            record — if a recording comes back silent, check System Settings → Privacy &amp;
            Security → Screen Recording and relaunch the app after enabling it.
          </p>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-sm text-xs border border-line text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            not now
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-sm text-xs bg-red-500 text-void font-semibold hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            got it — start recording
          </button>
        </div>
      </div>
    </div>
  );
}
