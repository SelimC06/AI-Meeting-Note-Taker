import { useRef } from "react";

// A high-polling-rate mouse or pen digitizer can fire pointermove far more
// often than the display (or main's own getCursorScreenPoint()+setBounds
// calls) can usefully act on -- same reasoning as DockedRail's own drag
// throttle.
const RESIZE_MOVE_MIN_INTERVAL_MS = 16;

const CURSOR_BY_DIRECTION: Record<ResizeDirection, string> = {
  n: "cursor-ns-resize",
  s: "cursor-ns-resize",
  e: "cursor-ew-resize",
  w: "cursor-ew-resize",
  ne: "cursor-nesw-resize",
  sw: "cursor-nesw-resize",
  nw: "cursor-nwse-resize",
  se: "cursor-nwse-resize",
};

// Invisible edge/corner strips overlaid on the dashboard's own border.
// Needed because a `transparent: true` BrowserWindow loses the native
// resize-by-dragging-the-frame-edge behavior on Windows entirely, regardless
// of `resizable: true` -- there's no OS-level hit-test border left to grab
// (see main.js's 'window:beginResize' handler for the main-process side).
export default function ResizeHandles() {
  const activeDirectionRef = useRef<ResizeDirection | null>(null);
  const lastMoveSentAtRef = useRef(0);

  const handlePointerDown = (direction: ResizeDirection) => (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom (the test environment) doesn't implement pointer capture.
    }
    activeDirectionRef.current = direction;
    window.windowControls?.beginWindowResize?.(direction);
  };

  const handlePointerMove = () => {
    if (!activeDirectionRef.current) return;
    const now = Date.now();
    if (now - lastMoveSentAtRef.current < RESIZE_MOVE_MIN_INTERVAL_MS) return;
    lastMoveSentAtRef.current = now;
    window.windowControls?.windowResizeMove?.();
  };

  const handlePointerUp = () => {
    if (!activeDirectionRef.current) return;
    activeDirectionRef.current = null;
    window.windowControls?.endWindowResize?.();
  };

  const handle = (direction: ResizeDirection, positionClassName: string) => (
    <div
      key={direction}
      onPointerDown={handlePointerDown(direction)}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      aria-hidden="true"
      className={
        "absolute touch-none [-webkit-app-region:no-drag] " +
        CURSOR_BY_DIRECTION[direction] + " " + positionClassName
      }
    />
  );

  return (
    <>
      {handle("n", "top-0 left-3 right-3 h-1.5")}
      {handle("s", "bottom-0 left-3 right-3 h-1.5")}
      {handle("w", "top-3 bottom-3 left-0 w-1.5")}
      {handle("e", "top-3 bottom-3 right-0 w-1.5")}
      {handle("nw", "top-0 left-0 h-3 w-3")}
      {handle("ne", "top-0 right-0 h-3 w-3")}
      {handle("sw", "bottom-0 left-0 h-3 w-3")}
      {handle("se", "bottom-0 right-0 h-3 w-3")}
    </>
  );
}
