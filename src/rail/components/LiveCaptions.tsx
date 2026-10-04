import { useEffect } from "react";
import CaptionCard from "../../ui/components/CaptionCard";
import type { LiveCaption } from "../hooks/useLiveCaptions";

interface LiveCaptionsProps {
  visible: boolean;
  captions: LiveCaption[];
}

// The floating rail's caption panel: window plumbing around CaptionCard.
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

  const newest = captions.length > 0 ? captions[captions.length - 1] : null;

  return (
    <div className="w-full flex-1 min-h-0">
      <CaptionCard
        caption={newest ? { speaker: newest.speaker, text: newest.text } : null}
        captionKey={newest?.id}
      />
    </div>
  );
}
