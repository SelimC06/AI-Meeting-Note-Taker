import { useEffect } from "react";
import type { LiveCaption } from "../hooks/useLiveCaptions";

interface LiveCaptionsProps {
  visible: boolean;
  captions: LiveCaption[];
}

// How many caption lines fit the fixed panel height
// (railGeometry.RAIL_CAPTIONS_PANEL_HEIGHT -- main.js sizes the window,
// this component must never need to scroll).
const VISIBLE_LINES = 3;

export default function LiveCaptions({ visible, captions }: LiveCaptionsProps) {
  // Same contract as ErrorToast's setRailErrorVisible: main.js grows or
  // shrinks the rail window to make room for this panel.
  useEffect(() => {
    window.electronAPI?.setRailCaptionsVisible?.(visible);
    return () => {
      window.electronAPI?.setRailCaptionsVisible?.(false);
    };
  }, [visible]);

  if (!visible) return null;

  const tail = captions.slice(-VISIBLE_LINES);

  return (
    <div
      role="log"
      aria-label="Live captions"
      aria-live="polite"
      className="w-full flex-1 overflow-hidden rounded-sm border border-line bg-panel px-3 py-1.5 text-[10px] leading-snug text-phosphor flex flex-col justify-end gap-0.5"
    >
      {tail.length === 0 ? (
        <span className="text-dim">listening…</span>
      ) : (
        tail.map((caption) => (
          <p key={caption.id} className="truncate">
            <span className="text-dim">{caption.speaker === "You" ? "you" : "them"}: </span>
            {caption.text}
          </p>
        ))
      )}
    </div>
  );
}
