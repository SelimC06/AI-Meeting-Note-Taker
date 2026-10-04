import TypewriterText from "./TypewriterText";

export type CaptionLine = { speaker: string; text: string };

interface CaptionCardProps {
  // The caption currently being spoken, or null while waiting for speech.
  caption: CaptionLine | null;
  // Stable identity of the caption (keys the entrance animation + the
  // typewriter restart). Unused when caption is null.
  captionKey?: string | number;
}

// The floating rail's live-caption surface. One deliberate design:
//
//   ┌──────────────────────────────────────┐
//   │ ● LIVE CAPTIONS                 you ●│   <- status strip
//   │                                      │
//   │ the line being spoken, typing on…▋   │   <- one caption, like real CC
//   └──────────────────────────────────────┘
//
// Only the newest caption is shown (a history stack clipped against the
// fixed height and read as broken). The body is bottom-anchored with
// hidden overflow, so a caption longer than the card scrolls its START
// out of the top -- the typing tail and cursor are always visible.
export default function CaptionCard({ caption, captionKey }: CaptionCardProps) {
  const isYou = caption?.speaker === "You";
  return (
    <div
      role="log"
      aria-label="Live captions"
      aria-live="polite"
      className="h-full w-full overflow-hidden rounded-lg border border-line bg-panel flex flex-col"
    >
      <div className="flex items-center gap-1.5 px-3 pt-1.5 shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-signal cursor-blink" aria-hidden="true" />
        <span className="font-sans text-[9px] uppercase tracking-[0.18em] text-dim select-none">
          live captions
        </span>
        {caption && (
          <span className="ml-auto flex items-center gap-1 font-sans text-[9px] uppercase tracking-[0.12em] text-dim">
            {caption.speaker === "You" ? "you" : "them"}
            <span
              aria-hidden="true"
              className={"h-1.5 w-1.5 rounded-full " + (isYou ? "bg-signal" : "")}
              style={isYou ? undefined : { background: "#7FA8C9" }}
            />
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden px-3 pb-2 pt-0.5 flex flex-col justify-end">
        {caption === null ? (
          <p className="font-reading text-[12px] leading-snug text-dim">
            listening for speech<span className="cursor-blink">▋</span>
          </p>
        ) : (
          <p key={captionKey} className="caption-in break-words font-reading text-[12px] leading-snug text-phosphor">
            <TypewriterText text={caption.text} />
            <span className="cursor-blink text-signal" aria-hidden="true">
              ▋
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
